import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm'
import { HttpStatus } from '@nestjs/common'

import { CheckoutService, CheckoutRequest } from './checkout.service'
import { Payment } from '../payment/entities/payment.entity'
import { PaymentAttempt } from '../payment/entities/paymentAttempt.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'

import { WalletService } from '../wallet/wallet.service'
import { InvoiceService } from '../invoice/invoice.service'
import { SubscriptionService } from '../subscription/subscription.service'
import { AuditService } from '../audit/audit.service'
import { TaxService } from '../tax/tax.service'
import { DianService } from '../dian/dian.service'
import { ProviderFactory } from '../provider/provider.factory'
import { EventBusService } from '../event-bus/event-bus.service'
import { ClientRolesService, PLAN_NOT_FOUND, PRICE_NOT_FOUND_FOR_COUNTRY } from '../client/client-roles.service'
import {
  ClientPlatformService,
  BRAND_LOOKUP_UNAVAILABLE,
  BRAND_NOT_FOUND,
  BRAND_WITHOUT_COUNTRY,
} from '../client/client-platform.service'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { WebhookService } from '../webhook/webhook.service'
import { RequestException } from '../shared/exception/request.exception'

/**
 * Marca de agua para detectar caídas accidentales al camino legacy de precios
 * (`getPlanPrice`). Si una aserción de monto ve 777777, el código NO resolvió
 * por país: es un número imposible de confundir con un precio real.
 */
const LEGACY_SENTINEL = 777777

const BRAND_ID = '72a8463b-1111-4c2a-9f1a-66a0985a10e6'

const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((data) => ({ id: 'mock-id', ...data })),
  save: jest.fn((data) => Promise.resolve({ id: 'mock-id', ...data })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
})

type PriceRowOver = Partial<{
  id: string
  countryCode: string
  currency: string
  price: number
  isDefault: boolean
}>

const priceRow = (over: PriceRowOver = {}) => ({
  id: 'price-1',
  countryCode: 'CO',
  currency: 'COP',
  price: 19900,
  isDefault: true,
  ...over,
})

describe('CheckoutService — precio del alta por país de la marca', () => {
  let service: CheckoutService
  let paymentRepo: ReturnType<typeof createMockRepo>
  /** Se nombra para poder sembrar la fila que el checkout REUSA y ver qué guarda encima. */
  let subscriptionRepo: ReturnType<typeof createMockRepo>
  let clientRoles: { getPlanPrice: jest.Mock; resolvePriceForCountry: jest.Mock; assignPlanToBrand: jest.Mock }
  let clientPlatform: { resolveBrandCountry: jest.Mock; getBrandCountry: jest.Mock }
  let enterprisePricing: { getForBrand: jest.Mock }
  let walletService: { debit: jest.Mock; findById: jest.Mock }
  let providerFactory: { getProvider: jest.Mock }
  let providerConfig: { isProviderAvailable: jest.Mock }
  let taxService: { getTaxForCountry: jest.Mock }
  let dianService: { isConfigured: jest.Mock; sendInvoice: jest.Mock }
  let createCheckout: jest.Mock

  /**
   * La wallet que `checkout` lee antes de debitar. Trae `brandId`: desde que la
   * guarda también verifica pertenencia, una wallet sin dueño es una wallet ajena.
   */
  const walletEn = (currency: string, brandId: string = BRAND_ID) =>
    ({ data: { id: 'w-1', brandId, currency } })

  beforeEach(async () => {
    paymentRepo = createMockRepo()
    subscriptionRepo = createMockRepo()
    createCheckout = jest.fn().mockResolvedValue({ providerPaymentId: 'ext-1', checkoutUrl: 'https://pay/1' })

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: paymentRepo },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subscriptionRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(BillingProfile, 'DBRead'), useValue: createMockRepo() },
        { provide: getDataSourceToken('DBWrite'), useValue: { createQueryRunner: jest.fn() } },
        {
          provide: WalletService,
          // `findById` es lo que lee el checkout para comparar la moneda de la wallet
          // contra la moneda resuelta: por defecto la wallet está en COP, así que los
          // casos en otra moneda tienen que declarar su wallet explícitamente.
          useValue: {
            debit: jest.fn().mockResolvedValue(null),
            findById: jest.fn().mockResolvedValue(walletEn('COP')),
          },
        },
        {
          provide: InvoiceService,
          // `generateInvoice` devuelve `result.data` de `InvoiceService.create`.
          useValue: {
            create: jest.fn().mockResolvedValue({ data: { id: 'inv-1', invoiceNumber: 'CK-1' } }),
          },
        },
        { provide: SubscriptionService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(null) } },
        {
          provide: TaxService,
          // taxRate 0 a propósito: `paymentRepo.create` recibe subtotal + impuesto,
          // así que con cualquier otra tasa las aserciones de 19900/6.99 estarían
          // midiendo el mock de impuestos y no el precio resuelto.
          useValue: {
            getTaxForCountry: jest.fn().mockResolvedValue({ taxName: 'N/A', taxRate: 0, isInclusive: false }),
          },
        },
        {
          provide: DianService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(false),
            sendInvoice: jest.fn().mockResolvedValue({ success: true }),
          },
        },
        { provide: ProviderFactory, useValue: { getProvider: jest.fn(() => ({ createCheckout })) } },
        {
          provide: EventBusService,
          useValue: {
            publishPaymentCompleted: jest.fn(),
            notifyPaymentSuccess: jest.fn(),
            notifyInvoiceReady: jest.fn(),
          },
        },
        {
          provide: ClientRolesService,
          useValue: {
            getPlanPrice: jest.fn().mockResolvedValue(LEGACY_SENTINEL),
            resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: priceRow() }),
            assignPlanToBrand: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: ClientPlatformService,
          useValue: {
            resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
            getBrandCountry: jest.fn().mockResolvedValue('CO'),
          },
        },
        { provide: EnterprisePricingService, useValue: { getForBrand: jest.fn().mockResolvedValue(null) } },
        { provide: ProviderConfigService, useValue: { isProviderAvailable: jest.fn().mockResolvedValue(true) } },
        { provide: WebhookService, useValue: { setCheckoutService: jest.fn() } },
      ],
    }).compile()

    service = module.get<CheckoutService>(CheckoutService)
    clientRoles = module.get(ClientRolesService)
    clientPlatform = module.get(ClientPlatformService)
    enterprisePricing = module.get(EnterprisePricingService)
    walletService = module.get(WalletService)
    providerFactory = module.get(ProviderFactory)
    providerConfig = module.get(ProviderConfigService)
    taxService = module.get(TaxService)
    dianService = module.get(DianService)
  })

  /** Alta con wallet: saltea el gate de proveedor y llega a `paymentRepo.create`. */
  const altaConWallet = (over: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    brandId: BRAND_ID,
    userId: 'u-1',
    purpose: 'plan_purchase',
    provider: 'wallet',
    planSlug: 'dropi-roax',
    walletId: 'w-1',
    ...over,
  })

  describe('alta (plan_purchase)', () => {
    it('marca CO → cobra 19.900 COP del catálogo', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'CO' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }),
      })

      await service.processCheckout(altaConWallet())

      expect(clientRoles.resolvePriceForCountry).toHaveBeenCalledWith('dropi-roax', 'CO')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 19900, currency: 'COP' }),
      )
    })

    it('marca US → cobra 6.99 USD del catálogo', async () => {
      walletService.findById.mockResolvedValue(walletEn('USD'))
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ id: 'price-us', countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })

      await service.processCheckout(altaConWallet())

      expect(clientRoles.resolvePriceForCountry).toHaveBeenCalledWith('dropi-roax', 'US')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 6.99, currency: 'USD' }),
      )
    })

    it('ignora la moneda que manda el cliente: marca US con currency COP igual cobra 6.99 USD', async () => {
      walletService.findById.mockResolvedValue(walletEn('USD'))
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ id: 'price-us', countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })

      await service.processCheckout(altaConWallet({ currency: 'COP' }))

      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 6.99, currency: 'USD' }),
      )
      expect(clientRoles.getPlanPrice).not.toHaveBeenCalled()
    })

    /**
     * Fila REAL del catálogo de dev, medida el 2026-08-25 con `GET /v1/plan`:
     * `free -> US:USD:0.00 | CO:COP:0.00:DEFAULT`. O sea que `free` **sí** resuelve
     * por país y cobra 0; el cero no es fabricado, sale de la fila. Se fija acá para
     * que quitarle las filas al plan se note como un cambio de contrato y no como un
     * 422 sorpresa en `POST /checkout`.
     */
    it('plan free → cobra 0 con la fila real del país (medida en el catálogo de dev)', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'CO' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ id: 'price-free-co', countryCode: 'CO', currency: 'COP', price: 0, isDefault: true }),
      })

      await service.processCheckout(altaConWallet({ planSlug: 'free' }))

      expect(clientRoles.resolvePriceForCountry).toHaveBeenCalledWith('free', 'CO')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 0, currency: 'COP' }),
      )
    })

    /**
     * El otro desenlace, para un plan que sí está sin filas en dev
     * (`ally_dropi_pro`/`ally_dropi_free`): el alta se rechaza con 422 y no persiste
     * nada. Es el caso demostrable de "país sin precio → rechazo".
     */
    it('plan sin filas en el catálogo → 422 y nada persistido', async () => {
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: false,
        code: PRICE_NOT_FOUND_FOR_COUNTRY,
      })

      await expect(
        service.processCheckout(altaConWallet({ planSlug: 'ally_dropi_pro' })),
      ).rejects.toMatchObject({ code: PRICE_NOT_FOUND_FOR_COUNTRY })

      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it.each([
      ['no numérico', 'no-es-un-precio'],
      ['ausente', null],
      ['negativo', -1],
    ])('fila de precio malformada (%s) → 422, no cobra NaN ni regala el plan', async (_caso, price) => {
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ price: price as unknown as number }),
      })

      await expect(
        service.processCheckout(altaConWallet()),
      ).rejects.toMatchObject({ code: PRICE_NOT_FOUND_FOR_COUNTRY })

      expect(paymentRepo.save).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    })

    it.each([
      ['con salto de línea', 'dropi-roax\nfake-log-line'],
      ['con path traversal', '../../admin'],
    ])('planSlug %s → 400 INVALID_PLAN_SLUG sin consultar nada', async (_caso, planSlug) => {
      await expect(
        service.processCheckout(altaConWallet({ planSlug })),
      ).rejects.toMatchObject({ code: 'INVALID_PLAN_SLUG' })

      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
      expect(clientRoles.resolvePriceForCountry).not.toHaveBeenCalled()
    })
  })
  describe('fallos de resolución (nada se persiste)', () => {
    /** Una sola invocación: el `expect.assertions` es lo que garantiza que lanzó. */
    const esperarFallo = async (req: CheckoutRequest, code: string, status: HttpStatus) => {
      expect.assertions(4)
      try {
        await service.processCheckout(req)
      } catch (error) {
        expect(error).toBeInstanceOf(RequestException)
        expect((error as RequestException).code).toBe(code)
        expect((error as RequestException).getStatus()).toBe(status)
      }
      expect(paymentRepo.save).not.toHaveBeenCalled()
    }

    it('no se pudo preguntar a platform → 503 BRAND_LOOKUP_UNAVAILABLE', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: false, code: BRAND_LOOKUP_UNAVAILABLE })
      await esperarFallo(altaConWallet(), BRAND_LOOKUP_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE)
    })

    it('platform no conoce la marca → 404 BRAND_NOT_FOUND', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: false, code: BRAND_NOT_FOUND })
      await esperarFallo(altaConWallet(), BRAND_NOT_FOUND, HttpStatus.NOT_FOUND)
    })

    it('marca sin país cargado → 422 BRAND_WITHOUT_COUNTRY', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: false, code: BRAND_WITHOUT_COUNTRY })
      await esperarFallo(altaConWallet(), BRAND_WITHOUT_COUNTRY, HttpStatus.UNPROCESSABLE_ENTITY)
    })

    it('plan sin precio para el país → 422 nombrando el plan pero NO el país de la marca', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'MX' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({ ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY })

      expect.assertions(5)
      try {
        await service.processCheckout(altaConWallet({ planSlug: 'ally_dropi_pro' }))
      } catch (error) {
        expect((error as RequestException).code).toBe(PRICE_NOT_FOUND_FOR_COUNTRY)
        expect((error as RequestException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
        expect((error as RequestException).getResponse()).toMatchObject({
          message: expect.stringContaining('ally_dropi_pro'),
        })
        // El endpoint contesta sin autenticar: devolver el país lo convertiría en un
        // lector del país de cualquier marca. El país va al log, no al cliente.
        expect(JSON.stringify((error as RequestException).getResponse())).not.toContain('MX')
      }
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('catálogo sin ese plan → 503 (no 404): es indistinguible de una caída de backend-roles', async () => {
      clientRoles.resolvePriceForCountry.mockResolvedValue({ ok: false, code: PLAN_NOT_FOUND })
      await esperarFallo(altaConWallet(), PLAN_NOT_FOUND, HttpStatus.SERVICE_UNAVAILABLE)
    })
  })

  describe('guarda de brandId (el checkout no tiene DTO que lo valide)', () => {
    const casos: Array<[string, any]> = [
      ['ausente', undefined],
      ['vacío', '   '],
      ['no-UUID', 'no-es-uuid'],
    ]

    it.each(casos)('brandId %s → 400 INVALID_BRAND_ID sin llamar a platform', async (_label, brandId) => {
      expect.assertions(4)
      try {
        await service.processCheckout(altaConWallet({ brandId }))
      } catch (error) {
        expect((error as RequestException).code).toBe('INVALID_BRAND_ID')
        expect((error as RequestException).getStatus()).toBe(HttpStatus.BAD_REQUEST)
      }
      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('un UUID con espacios se normaliza una vez y viaja limpio a platform y al pago', async () => {
      await service.processCheckout(altaConWallet({ brandId: `  ${BRAND_ID}  ` }))

      expect(clientPlatform.resolveBrandCountry).toHaveBeenCalledWith(BRAND_ID)
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ brandId: BRAND_ID }),
      )
    })

    it('el brandId se valida ANTES de consultar el precio negociado enterprise', async () => {
      await expect(
        service.processCheckout(altaConWallet({ planSlug: 'enterprise', brandId: 'no-es-uuid' })),
      ).rejects.toMatchObject({ code: 'INVALID_BRAND_ID' })

      expect(enterprisePricing.getForBrand).not.toHaveBeenCalled()
    })
  })

  /**
   * El `planSlug` es parte del CONTRATO de `plan_purchase`, no un extra opcional:
   * sin él no hay plan que comprar y el precio por país no se puede resolver.
   * Antes la rama de plan se gateaba con `&& req.planSlug`, así que una compra sin
   * slug caía a la rama genérica y cobraba el `amount`/`currency` que mandaba el
   * llamador, dejando una fila de `payments` con `purpose=plan_purchase` y
   * `purposeId=null`, la wallet debitada y una factura "Plan undefined".
   */
  describe('planSlug obligatorio en la compra de plan', () => {
    const ausentes: Array<[string, any]> = [
      ['ausente', undefined],
      ['null', null],
      ['vacío', ''],
      ['sólo espacios', '   '],
    ]

    it.each(ausentes)('planSlug %s → 400 INVALID_PLAN_SLUG sin consultar nada', async (_label, planSlug) => {
      expect.assertions(6)
      try {
        await service.processCheckout(altaConWallet({ planSlug }))
      } catch (error) {
        expect((error as RequestException).code).toBe('INVALID_PLAN_SLUG')
        expect((error as RequestException).getStatus()).toBe(HttpStatus.BAD_REQUEST)
      }
      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
      expect(clientRoles.resolvePriceForCountry).not.toHaveBeenCalled()
      expect(paymentRepo.save).not.toHaveBeenCalled()
      expect(walletService.debit).not.toHaveBeenCalled()
    })

    /**
     * La regresión exacta que cierra la tarea: con `amount`/`currency` en la request,
     * la compra sin slug cobraba 1 USD elegidos por el llamador.
     */
    it('no cobra el amount/currency del llamador cuando falta el planSlug', async () => {
      await expect(
        service.processCheckout(altaConWallet({ planSlug: undefined, amount: 1, currency: 'USD' })),
      ).rejects.toMatchObject({ code: 'INVALID_PLAN_SLUG' })

      expect(paymentRepo.create).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    })

    /**
     * La indulgencia de la renovación está acotada a los CÓDIGOS de resolución de
     * país/precio, no al contrato: sin slug no hay precio legacy que resolver.
     */
    it('renewal:true sin planSlug también se rechaza y no cae al precio legacy', async () => {
      await expect(
        service.processCheckout(altaConWallet({ planSlug: undefined, renewal: true, amount: 1, currency: 'COP' })),
      ).rejects.toMatchObject({ code: 'INVALID_PLAN_SLUG' })

      expect(clientRoles.getPlanPrice).not.toHaveBeenCalled()
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    /** La guarda quedó acotada a `plan_purchase`: los otros propósitos no la ven. */
    const otrosPropositos: Array<[string, CheckoutRequest['purpose']]> = [
      ['wallet_recharge', 'wallet_recharge'],
      ['service_payment', 'service_payment'],
    ]

    it.each(otrosPropositos)('%s sin planSlug sigue cobrando el amount/currency del llamador', async (_label, purpose) => {
      await service.processCheckout(
        altaConWallet({ purpose, planSlug: undefined, amount: 50000, currency: 'COP' }),
      )

      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50000, currency: 'COP' }),
      )
    })
  })

  describe('renovación del cron (indulgente: intenta el país, cae al legacy)', () => {
    /**
     * El criterio (e) pide "estricto en el alta, indulgente en la renovación": la
     * renovación intenta el mismo catálogo por país y sólo cae al precio legacy si
     * NO puede resolverlo. Que el alta cobre en USD y la renovación de la MISMA
     * suscripción en COP —para siempre, porque `subscriptions` no guarda moneda— es
     * lo que estos tests prohíben.
     */
    it('renewal:true en marca US cobra 6,99 USD: alta y renovación no divergen', async () => {
      walletService.findById.mockResolvedValue(walletEn('USD'))
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })

      await service.processCheckout(altaConWallet({ renewal: true }))

      expect(clientRoles.resolvePriceForCountry).toHaveBeenCalledWith('dropi-roax', 'US')
      expect(clientRoles.getPlanPrice).not.toHaveBeenCalled()
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 6.99, currency: 'USD' }),
      )
    })

    it.each([
      ['platform no responde', { ok: false, code: BRAND_LOOKUP_UNAVAILABLE }],
      ['la marca no existe', { ok: false, code: BRAND_NOT_FOUND }],
      ['la marca no tiene país', { ok: false, code: BRAND_WITHOUT_COUNTRY }],
    ])('si %s, la renovación NO falla: cae al precio legacy', async (_caso, resolution) => {
      const logError = jest.spyOn((service as any).log, 'error').mockImplementation(() => undefined)
      clientPlatform.resolveBrandCountry.mockResolvedValue(resolution)

      await service.processCheckout(altaConWallet({ renewal: true }))

      // Ser estricto acá no da un 4xx a nadie: `issueExternalCharge` atrapa, marca
      // `past_due` sin link de pago y tras MAX_RETRY degrada la marca a free.
      expect(clientRoles.getPlanPrice).toHaveBeenCalledWith('dropi-roax', 'COP')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: LEGACY_SENTINEL, currency: 'COP' }),
      )
      expect(logError).toHaveBeenCalledWith(expect.stringContaining(BRAND_ID))
    })

    it('si el plan no tiene precio para el país, la renovación cae al legacy con el país en el log', async () => {
      const logError = jest.spyOn((service as any).log, 'error').mockImplementation(() => undefined)
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'MX' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({ ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY })

      await service.processCheckout(altaConWallet({ renewal: true }))

      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: LEGACY_SENTINEL, currency: 'COP' }),
      )
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('MX'))
      expect(logError).toHaveBeenCalledWith(expect.stringContaining(PRICE_NOT_FOUND_FOR_COUNTRY))
    })

    /**
     * `subscriptions.brandId` es un `varchar` sin FK ni tipo `uuid`, y la convención
     * del monorepo es que los ids cross-service son strings. Aplicarle al cron la
     * guarda de UUID del alta convertía toda suscripción con un id no canónico en un
     * `past_due` sin link de pago y, tras MAX_RETRY, en una marca degradada a free.
     */
    it('renewal:true con un brandId que no es UUID cobra el precio legacy y NO lanza', async () => {
      const logError = jest.spyOn((service as any).log, 'error').mockImplementation(() => undefined)
      walletService.findById.mockResolvedValue(walletEn('COP', 'b1'))

      await service.processCheckout(altaConWallet({ renewal: true, brandId: 'b1' }))

      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
      expect(clientRoles.getPlanPrice).toHaveBeenCalledWith('dropi-roax', 'COP')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ brandId: 'b1', amount: LEGACY_SENTINEL, currency: 'COP' }),
      )
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('b1'))
    })

    it('renewal:true sin precio legacy sigue lanzando INVALID_PLAN', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: false, code: BRAND_LOOKUP_UNAVAILABLE })
      clientRoles.getPlanPrice.mockResolvedValue(null)

      await expect(
        service.processCheckout(altaConWallet({ renewal: true })),
      ).rejects.toMatchObject({ code: 'INVALID_PLAN' })
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('el alta con los mismos datos exige UUID; la renovación no (el atajo es del llamador)', async () => {
      await expect(
        service.processCheckout(altaConWallet({ brandId: 'b1' })),
      ).rejects.toMatchObject({ code: 'INVALID_BRAND_ID' })
    })
  })

  describe('enterprise', () => {
    it('con precio negociado en la moneda pedida cobra lo negociado y no consulta país', async () => {
      enterprisePricing.getForBrand.mockResolvedValue({ monthlyPrice: 1234567, currency: 'COP' })

      await service.processCheckout(altaConWallet({ planSlug: 'enterprise' }))

      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1234567, currency: 'COP' }),
      )
      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
      expect(clientRoles.resolvePriceForCountry).not.toHaveBeenCalled()
    })

    it('spec negativa: otro plan con fila enterprise presente resuelve el catálogo por país', async () => {
      enterprisePricing.getForBrand.mockResolvedValue({ monthlyPrice: 1234567, currency: 'COP' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }),
      })

      await service.processCheckout(altaConWallet({ planSlug: 'dropi-roax' }))

      expect(enterprisePricing.getForBrand).not.toHaveBeenCalled()
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 19900, currency: 'COP' }),
      )
    })

    it('enterprise sin fila negociada cae al catálogo por país (cambio de comportamiento specado)', async () => {
      walletService.findById.mockResolvedValue(walletEn('USD'))
      enterprisePricing.getForBrand.mockResolvedValue(null)
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'US', currency: 'USD', price: 199, isDefault: false }),
      })

      await service.processCheckout(altaConWallet({ planSlug: 'enterprise' }))

      expect(clientRoles.resolvePriceForCountry).toHaveBeenCalledWith('enterprise', 'US')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 199, currency: 'USD' }),
      )
    })

    it('alta: la fila negociada manda aunque el cliente pida otra moneda', async () => {
      walletService.findById.mockResolvedValue(walletEn('USD'))
      enterprisePricing.getForBrand.mockResolvedValue({ monthlyPrice: 900, currency: 'USD' })

      await service.processCheckout(altaConWallet({ planSlug: 'enterprise', currency: 'COP' }))

      // Sin esto, mandar una moneda que no matchea saca al alta de lo negociado y la
      // deja en el precio de lista del país: un descuento elegido por el cliente.
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 900, currency: 'USD' }),
      )
      expect(clientRoles.resolvePriceForCountry).not.toHaveBeenCalled()
    })

    it('renovación: la fila negociada en la moneda legacy manda, sin consultar el país', async () => {
      enterprisePricing.getForBrand.mockResolvedValue({ monthlyPrice: 900, currency: 'COP' })

      await service.processCheckout(altaConWallet({ planSlug: 'enterprise', renewal: true }))

      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 900, currency: 'COP' }),
      )
      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
    })

    it('renovación: con la fila negociada en otra moneda pasa al catálogo por país', async () => {
      enterprisePricing.getForBrand.mockResolvedValue({ monthlyPrice: 900, currency: 'USD' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ currency: 'COP', price: 599000 }),
      })

      await service.processCheckout(altaConWallet({ planSlug: 'enterprise', renewal: true }))

      // La comparación legacy `customPricing.currency === req.currency` queda intacta
      // en la renovación; lo que cambia es a dónde cae cuando no matchea.
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 599000, currency: 'COP' }),
      )
    })
  })

  describe('moneda de la wallet', () => {
    /** Marca US: el catálogo resuelve 6,99 USD. */
    const marcaUS = () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ id: 'price-us', countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })
    }

    it('wallet en COP para un cobro en USD → 422 sin debitar, sin plan y sin pago persistido', async () => {
      marcaUS()
      walletService.findById.mockResolvedValue(walletEn('COP'))

      expect.assertions(5)
      try {
        await service.processCheckout(altaConWallet())
      } catch (error) {
        expect((error as RequestException).code).toBe('WALLET_CURRENCY_MISMATCH')
        expect((error as RequestException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      }
      // Sin esta guarda se debitaban 6,99 COP (≈USD 0,002) por un plan de 6,99 USD, con
      // factura emitida en USD. El pre-chequeo sigue existiendo aunque `WalletService.debit`
      // ya compare monedas: acá el 422 llega ANTES de persistir la fila de `payments`, y
      // `debit` vuelve a comparar sobre la fila bloqueada como último respaldo.
      expect(walletService.debit).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('wallet en la moneda resuelta debita el total y asigna el plan', async () => {
      marcaUS()
      walletService.findById.mockResolvedValue(walletEn('USD'))

      await service.processCheckout(altaConWallet())

      expect(walletService.debit).toHaveBeenCalledWith('w-1', 6.99, expect.any(Object), 'USD')
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalled()
    })

    /**
     * `WalletService.findById(undefined)` NO falla: TypeORM descarta las condiciones
     * `undefined` y la consulta degenera en "la primera wallet de la tabla", así que
     * sin este rechazo la guarda compararía —y filtraría— la moneda de una wallet
     * ajena mientras el débito posterior toca otra.
     */
    it('sin walletId → 400 MISSING_WALLET_ID antes de leer wallet alguna', async () => {
      await expect(
        service.processCheckout(altaConWallet({ walletId: undefined })),
      ).rejects.toMatchObject({ code: 'MISSING_WALLET_ID' })

      expect(walletService.findById).not.toHaveBeenCalled()
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('wallet de OTRA marca → 404 genérico, sin decir en qué moneda está', async () => {
      walletService.findById.mockResolvedValue(walletEn('COP', 'otra-marca'))

      expect.assertions(4)
      try {
        await service.processCheckout(altaConWallet())
      } catch (error) {
        expect((error as RequestException).code).toBe('WALLET_NOT_FOUND')
        expect((error as RequestException).getStatus()).toBe(HttpStatus.NOT_FOUND)
        expect(JSON.stringify((error as RequestException).getResponse())).not.toContain('COP')
      }
      expect(walletService.debit).not.toHaveBeenCalled()
    })

    /**
     * La guarda es del alta de plan: es el único camino cuya moneda dejó de ser la
     * del llamador. Un `service_payment` sigue cobrando lo que pide el llamador y no
     * gana un 422 que antes no existía.
     */
    it('service_payment con wallet en otra moneda sigue pasando (guarda acotada al alta)', async () => {
      walletService.findById.mockResolvedValue(walletEn('COP'))

      await service.processCheckout({
        brandId: BRAND_ID,
        userId: 'u-1',
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: 'w-1',
        amount: 50,
        currency: 'USD',
      })

      expect(walletService.debit).toHaveBeenCalledWith('w-1', 50, expect.any(Object), undefined)
    })
  })

  describe('coherencia de país: proveedor, impuesto y DIAN', () => {
    const marcaUS = () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })
    }

    /**
     * El monto viaja en la moneda del país de la marca; gatear al proveedor por el
     * perfil de facturación (`|| 'CO'`) le mandaba USD a un proveedor habilitado
     * sólo para CO y nunca validado para esa moneda.
     */
    it('el gate de proveedor usa el país que decidió el precio, no el de facturación', async () => {
      marcaUS()

      await service.processCheckout(
        altaConWallet({ provider: 'stripe', walletId: undefined }),
      )

      expect(providerConfig.isProviderAvailable).toHaveBeenCalledWith('US', 'stripe')
    })

    it('proveedor no habilitado en el país del precio → PROVIDER_NOT_AVAILABLE', async () => {
      marcaUS()
      providerConfig.isProviderAvailable.mockResolvedValue(false)

      await expect(
        service.processCheckout(altaConWallet({ provider: 'confio', walletId: undefined })),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' })
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('precio en USD → el impuesto se calcula para US, no el 19% colombiano', async () => {
      marcaUS()
      walletService.findById.mockResolvedValue(walletEn('USD'))

      await service.processCheckout(altaConWallet())

      expect(taxService.getTaxForCountry).toHaveBeenCalledWith('US')
    })

    it('precio en COP → el impuesto sigue saliendo del perfil de facturación', async () => {
      await service.processCheckout(altaConWallet())

      expect(taxService.getTaxForCountry).toHaveBeenCalledWith('CO')
    })

    it('factura en USD → no se manda a la DIAN aunque esté configurada', async () => {
      marcaUS()
      walletService.findById.mockResolvedValue(walletEn('USD'))
      dianService.isConfigured.mockReturnValue(true)

      await service.processCheckout(altaConWallet())

      expect(dianService.sendInvoice).not.toHaveBeenCalled()
    })

    it('factura en COP → se manda a la DIAN como hasta hoy', async () => {
      dianService.isConfigured.mockReturnValue(true)

      await service.processCheckout(altaConWallet())

      expect(dianService.sendInvoice).toHaveBeenCalledWith('inv-1')
    })
  })

  describe('proveedor externo', () => {
    it('la moneda resuelta es la que se manda al proveedor, no la del cliente', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ id: 'price-us', countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })

      await service.processCheckout(
        altaConWallet({ provider: 'stripe', walletId: undefined, currency: 'COP' }),
      )

      expect(providerFactory.getProvider).toHaveBeenCalledWith('stripe')
      expect(createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 6.99, currency: 'USD' }),
      )
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 6.99, currency: 'USD' }),
      )
      // La guarda de moneda es del camino wallet: acá no hay wallet que comparar.
      expect(walletService.findById).not.toHaveBeenCalled()
    })
  })
  /**
   * LA RECOMPRA NO DEVUELVE LA PRUEBA. El checkout REUSA la fila de la marca —hay una
   * sola por `brandId`, índice único— y la revive campo por campo. `trialStart` es la
   * marca durable de prueba consumida (la invariante vive al lado de la columna en
   * `subscription.entity.ts`) y este es el único camino que revive una fila muerta sin
   * pasar por `startTrial`: si alguna vez la limpiara, la marca volvería a tener prueba
   * gratis cada vez que paga y cancela.
   */
  describe('reuso de la fila (la marca de prueba consumida sobrevive)', () => {
    // MUTACIÓN QUE LO PONE ROJO: agregar `subscription.trialStart = null` (o `trialEnd`)
    // en la rama de reuso de `createOrRenewSubscription` ⇒ este caso se cae.
    it('la fila terminal que se recompra vuelve a active con trialStart y trialEnd intactos', async () => {
      const INICIO_TRIAL = new Date('2026-01-01T00:00:00.000Z')
      const FIN_TRIAL = new Date('2026-01-16T00:00:00.000Z')
      // La fila tal cual la dejó el cierre del ciclo anterior: terminal, sin renovación
      // y con la prueba ya gastada.
      const fila: any = {
        id: 'sub-1',
        brandId: BRAND_ID,
        userId: 'u-1',
        planSlug: 'dropi-roax',
        status: 'expired',
        autoRenew: false,
        accessEndsAt: null,
        cancelledAt: new Date('2026-01-16T00:00:00.000Z'),
        cancelReason: 'baja voluntaria',
        retryCount: 3,
        trialStart: INICIO_TRIAL,
        trialEnd: FIN_TRIAL,
      }
      subscriptionRepo.findOne.mockResolvedValue(fila)

      await service.processCheckout(altaConWallet())

      // Se guardó ESA fila (reuso, no alta nueva) y ya revivida.
      expect(subscriptionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sub-1', status: 'active', autoRenew: true }),
      )
      // Y con la marca de prueba intacta: la vuelta fue PAGANDO, no con otra prueba.
      const guardada = subscriptionRepo.save.mock.calls[0][0]
      expect(guardada.trialStart).toBe(INICIO_TRIAL)
      expect(guardada.trialEnd).toBe(FIN_TRIAL)
    })
  })
})
