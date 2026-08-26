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
  let clientRoles: { getPlanPrice: jest.Mock; resolvePriceForCountry: jest.Mock; assignPlanToBrand: jest.Mock }
  let clientPlatform: { resolveBrandCountry: jest.Mock; getBrandCountry: jest.Mock }
  let enterprisePricing: { getForBrand: jest.Mock }
  let walletService: { debit: jest.Mock; findById: jest.Mock }
  let providerFactory: { getProvider: jest.Mock }
  let createCheckout: jest.Mock

  /** La wallet que `checkout` lee para comparar monedas antes de debitar. */
  const walletEn = (currency: string) => ({ data: { id: 'w-1', currency } })

  beforeEach(async () => {
    paymentRepo = createMockRepo()
    createCheckout = jest.fn().mockResolvedValue({ providerPaymentId: 'ext-1', checkoutUrl: 'https://pay/1' })

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: paymentRepo },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: createMockRepo() },
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
          useValue: { isConfigured: jest.fn().mockReturnValue(false), sendInvoice: jest.fn() },
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

    it('plan free → cobra 0 en la moneda de la fila real del país (no un cero fabricado)', async () => {
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

    it('plan sin precio para el país → 422 PRICE_NOT_FOUND_FOR_COUNTRY nombrando plan y país', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'MX' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({ ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY })

      expect.assertions(4)
      try {
        await service.processCheckout(altaConWallet({ planSlug: 'ally_dropi_pro' }))
      } catch (error) {
        expect((error as RequestException).code).toBe(PRICE_NOT_FOUND_FOR_COUNTRY)
        expect((error as RequestException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
        expect((error as RequestException).getResponse()).toMatchObject({
          message: expect.stringMatching(/ally_dropi_pro.*MX/),
        })
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

  describe('renovación del cron (no cambia de comportamiento)', () => {
    it('renewal:true en marca US cobra el precio legacy en COP y no resuelve país', async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })

      await service.processCheckout(altaConWallet({ renewal: true }))

      expect(clientRoles.getPlanPrice).toHaveBeenCalledWith('dropi-roax', 'COP')
      expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
      expect(clientRoles.resolvePriceForCountry).not.toHaveBeenCalled()
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: LEGACY_SENTINEL, currency: 'COP' }),
      )
    })

    it('renewal:true sin precio legacy sigue lanzando INVALID_PLAN', async () => {
      clientRoles.getPlanPrice.mockResolvedValue(null)

      await expect(
        service.processCheckout(altaConWallet({ renewal: true })),
      ).rejects.toMatchObject({ code: 'INVALID_PLAN' })
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('los mismos datos SIN renewal resuelven por país (el atajo es del llamador, no de los datos)', async () => {
      walletService.findById.mockResolvedValue(walletEn('USD'))
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'US' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({
        ok: true,
        price: priceRow({ countryCode: 'US', currency: 'USD', price: 6.99, isDefault: false }),
      })

      await service.processCheckout(altaConWallet())

      expect(clientRoles.getPlanPrice).not.toHaveBeenCalled()
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 6.99, currency: 'USD' }),
      )
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

    it('renovación: con la fila negociada en otra moneda sigue cayendo al precio legacy', async () => {
      enterprisePricing.getForBrand.mockResolvedValue({ monthlyPrice: 900, currency: 'USD' })

      await service.processCheckout(altaConWallet({ planSlug: 'enterprise', renewal: true }))

      expect(clientRoles.getPlanPrice).toHaveBeenCalledWith('enterprise', 'COP')
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: LEGACY_SENTINEL, currency: 'COP' }),
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
      // `WalletService.debit` no compara monedas: sin esta guarda se debitaban 6,99 COP
      // (≈USD 0,002) por un plan de 6,99 USD, con factura emitida en USD.
      expect(walletService.debit).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(paymentRepo.save).not.toHaveBeenCalled()
    })

    it('wallet en la moneda resuelta debita el total y asigna el plan', async () => {
      marcaUS()
      walletService.findById.mockResolvedValue(walletEn('USD'))

      await service.processCheckout(altaConWallet())

      expect(walletService.debit).toHaveBeenCalledWith('w-1', 6.99, expect.any(Object))
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalled()
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
})
