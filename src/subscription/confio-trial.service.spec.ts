import { HttpStatus, Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { ConfioTrialService } from './confio-trial.service'
import { ClientPlatformService, BRAND_LOOKUP_UNAVAILABLE, BRAND_NOT_FOUND, BRAND_WITHOUT_COUNTRY } from '../client/client-platform.service'
import { ClientRolesService, PLAN_NOT_FOUND, PRICE_NOT_FOUND_FOR_COUNTRY } from '../client/client-roles.service'
import { ClientAuthService, USER_LOOKUP_UNAVAILABLE, USER_NOT_FOUND } from '../client/client-auth.service'
import { ConfioPlanService } from '../provider/confio/confio-plan.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
import { RequestException } from '../shared/exception/request.exception'

const BRAND = 'brand-1'
const USER = 'user-1'
const PLAN = 'dropi-roax'
const CONFIO_PLAN = 'stores/store-1/subscription-plans/plan-1'
const CONFIO_SUB = `${CONFIO_PLAN}/subscriptions/sub-1`

/** Fila de precio tal cual la sirve `ClientRolesService` (congelada en su caché). */
const PRICE_CO = { id: 'p-1', countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }

/** Respuesta del alta: `PENDING_ACCEPTANCE` + link portador, sin período abierto. */
const ALTA = {
  providerSubscriptionId: CONFIO_SUB,
  status: 'PENDING_ACCEPTANCE',
  acceptanceUrl: 'https://pay.dev.confiopagos.com/accept/abc123',
  acceptanceExpireTime: new Date('2026-09-02T00:00:00.000Z'),
  correlationId: undefined,
  raw: { name: CONFIO_SUB, status: 'PENDING_ACCEPTANCE' },
}

describe('ConfioTrialService', () => {
  let service: ConfioTrialService
  let clientPlatform: { resolveBrandCountry: jest.Mock }
  let clientRoles: { resolvePriceForCountry: jest.Mock }
  let clientAuth: { resolveBuyerContact: jest.Mock }
  let confioPlans: { resolveConfioPlanName: jest.Mock }
  let confio: { createSubscription: jest.Mock; getSubscription: jest.Mock }

  beforeEach(async () => {
    clientPlatform = { resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }) }
    clientRoles = { resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: PRICE_CO }) }
    clientAuth = {
      resolveBuyerContact: jest.fn().mockResolvedValue({
        ok: true,
        contact: { email: 'manuel@roaxai.com', name: 'Manuel', phone: '3215786325', callingCode: '57' },
      }),
    }
    confioPlans = { resolveConfioPlanName: jest.fn().mockResolvedValue(CONFIO_PLAN) }
    confio = {
      createSubscription: jest.fn().mockResolvedValue(ALTA),
      getSubscription: jest.fn().mockResolvedValue(ALTA),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfioTrialService,
        { provide: ClientPlatformService, useValue: clientPlatform },
        { provide: ClientRolesService, useValue: clientRoles },
        { provide: ClientAuthService, useValue: clientAuth },
        { provide: ConfioPlanService, useValue: confioPlans },
        { provide: ConfioProvider, useValue: confio },
      ],
    }).compile()

    service = module.get(ConfioTrialService)
  })

  const alta = (extra: Record<string, any> = {}) =>
    service.createForTrial({ brandId: BRAND, userId: USER, planSlug: PLAN, ...extra })

  describe('createForTrial — resolución país → precio → plan → comprador', () => {
    it('resuelve la moneda por el país de la marca y pide con ella el plan de ConfioPagos', async () => {
      const result = await alta()

      expect(clientPlatform.resolveBrandCountry).toHaveBeenCalledWith(BRAND)
      expect(clientRoles.resolvePriceForCountry).toHaveBeenCalledWith(PLAN, 'CO')
      // La moneda sale de la FILA de precio, no del llamador ni del país.
      expect(confioPlans.resolveConfioPlanName).toHaveBeenCalledWith(PLAN, 'COP')
      expect(result).toBe(ALTA)
    })

    it('manda el comprador NORMALIZADO: E.164 con el callingCode y el nombre único replicado', async () => {
      await alta()

      expect(confio.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          planName: CONFIO_PLAN,
          buyer: {
            email: 'manuel@roaxai.com',
            firstName: 'Manuel',
            lastName: 'Manuel',
            phoneNumber: '+573215786325',
          },
        }),
      )
    })

    it('el `correlationId` viaja cuando el llamador lo pasa', async () => {
      await alta({ correlationId: 'sub-local-1' })

      expect(confio.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'sub-local-1' }),
      )
    })

    it('sin `correlationId` la CLAVE no existe en el parámetro (no un `undefined`)', async () => {
      await alta()

      const params = confio.createSubscription.mock.calls[0][0]
      expect(Object.keys(params)).not.toContain('correlationId')
    })
  })

  // A dónde vuelve el comprador después de registrar su medio de pago. Antes no se
  // mandaba nunca y se quedaba en la página de ConfioPagos — verificado con un pago
  // real el 2026-09-02.
  describe('createForTrial — retorno del comprador', () => {
    const RETORNO_ORIGINAL = process.env.SUBSCRIPTION_RETURN_URL

    afterEach(() => {
      if (RETORNO_ORIGINAL === undefined) delete process.env.SUBSCRIPTION_RETURN_URL
      else process.env.SUBSCRIPTION_RETURN_URL = RETORNO_ORIGINAL
    })

    it('manda `redirectUri` con la URL configurada', async () => {
      // Mutación: no pasar el parámetro — el comprador se queda en ConfioPagos.
      process.env.SUBSCRIPTION_RETURN_URL = 'https://app.dropi.co/dashboard/roax/reports/subscription'

      await alta()

      expect(confio.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUri: 'https://app.dropi.co/dashboard/roax/reports/subscription',
        }),
      )
    })

    it('sin configurar, la CLAVE no existe: no se compone un host', async () => {
      // Mutación: caer a un default con `DOMAIN` — el comprador vuelve a un dominio
      // NUESTRO, que no es donde vive la pantalla de ROAX. La clave presente con
      // `undefined` tampoco sirve: el provider la distingue con `!== undefined`.
      delete process.env.SUBSCRIPTION_RETURN_URL
      process.env.DOMAIN = 'cubiko.dev'

      await alta()

      const params = confio.createSubscription.mock.calls[0][0]
      expect(Object.keys(params)).not.toContain('redirectUri')
    })

    it('una URL en blanco se trata como no configurada', async () => {
      // Mutación: chequear sólo `!== undefined` en vez de `trim()` — viaja un
      // `redirectUri: '   '` y ConfioPagos manda al comprador a la nada.
      process.env.SUBSCRIPTION_RETURN_URL = '   '

      await alta()

      const params = confio.createSubscription.mock.calls[0][0]
      expect(Object.keys(params)).not.toContain('redirectUri')
    })

    it('el aviso de que falta la URL se da UNA vez, no en cada alta', async () => {
      // Mutación: loguear dentro del camino del alta en vez de tras el flag — un
      // ambiente sin la variable llena el log con una línea por suscripción.
      delete process.env.SUBSCRIPTION_RETURN_URL
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

      await alta()
      await alta()
      await alta()

      const avisos = warn.mock.calls.filter((c) => String(c[0]).includes('SUBSCRIPTION_RETURN_URL'))
      expect(avisos).toHaveLength(1)
      warn.mockRestore()
    })
  })

  describe('createForTrial — país/precio mapean al MISMO HTTP que el checkout', () => {
    it.each([
      [BRAND_LOOKUP_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE],
      [BRAND_NOT_FOUND, HttpStatus.NOT_FOUND],
      [BRAND_WITHOUT_COUNTRY, HttpStatus.UNPROCESSABLE_ENTITY],
    ])('%s → %i', async (code, status) => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: false, code })

      const error = await alta().catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe(code)
      expect(error.getStatus()).toBe(status)
      expect(confio.createSubscription).not.toHaveBeenCalled()
    })

    it(`${PLAN_NOT_FOUND} → 503 (no 404): el catálogo vacío es un outage de roles, no un plan inexistente`, async () => {
      clientRoles.resolvePriceForCountry.mockResolvedValue({ ok: false, code: PLAN_NOT_FOUND })

      const error = await alta().catch((e) => e)

      expect(error.code).toBe(PLAN_NOT_FOUND)
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    })

    it(`${PRICE_NOT_FOUND_FOR_COUNTRY} → 422 y SIN el país en el mensaje`, async () => {
      clientPlatform.resolveBrandCountry.mockResolvedValue({ ok: true, country: 'AR' })
      clientRoles.resolvePriceForCountry.mockResolvedValue({ ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY })

      const error = await alta().catch((e) => e)

      expect(error.code).toBe(PRICE_NOT_FOUND_FOR_COUNTRY)
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      expect(error.getResponse().message).not.toContain('AR')
    })

    it('el rechazo de `ConfioPlanService` se propaga tal cual (CONFIO_PLAN_NOT_MAPPED 422)', async () => {
      confioPlans.resolveConfioPlanName.mockRejectedValue(
        new RequestException({ code: 'CONFIO_PLAN_NOT_MAPPED', message: 'x' }, HttpStatus.UNPROCESSABLE_ENTITY),
      )

      const error = await alta().catch((e) => e)

      expect(error.code).toBe('CONFIO_PLAN_NOT_MAPPED')
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      expect(confio.createSubscription).not.toHaveBeenCalled()
    })
  })

  describe('createForTrial — comprador', () => {
    it(`${USER_LOOKUP_UNAVAILABLE} → 503: auth caído no es "tus datos están mal"`, async () => {
      clientAuth.resolveBuyerContact.mockResolvedValue({ ok: false, code: USER_LOOKUP_UNAVAILABLE })

      const error = await alta().catch((e) => e)

      expect(error.code).toBe(USER_LOOKUP_UNAVAILABLE)
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
      expect(confio.createSubscription).not.toHaveBeenCalled()
    })

    it(`${USER_NOT_FOUND} → 422`, async () => {
      clientAuth.resolveBuyerContact.mockResolvedValue({ ok: false, code: USER_NOT_FOUND })

      const error = await alta().catch((e) => e)

      expect(error.code).toBe(USER_NOT_FOUND)
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    })

    it('un teléfono local sin callingCode → 422 INVALID_BUYER con el campo, SIN el detalle (PII)', async () => {
      clientAuth.resolveBuyerContact.mockResolvedValue({
        ok: true,
        contact: { email: 'manuel@roaxai.com', name: 'Manuel Perez', phone: '3215786325' },
      })

      const error = await alta().catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('INVALID_BUYER')
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      expect(error.getResponse().field).toBe('buyer.phoneNumber')
      // El detalle del error lleva el teléfono: no puede volver al cliente.
      expect(JSON.stringify(error.getResponse())).not.toContain('3215786325')
      expect(confio.createSubscription).not.toHaveBeenCalled()
    })
  })

  describe('createForTrial — fallos de la pasarela', () => {
    it('un 500 de ConfioPagos → 503 CONFIO_SUBSCRIPTION_UNAVAILABLE sin reexponer su cuerpo', async () => {
      confio.createSubscription.mockRejectedValue(
        new Error('ConfioPagos 500: {"trace":"deadbeef","detail":"panic en su base"}'),
      )

      const error = await alta().catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('CONFIO_SUBSCRIPTION_UNAVAILABLE')
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
      expect(JSON.stringify(error.getResponse())).not.toContain('deadbeef')
    })

    // Los cuatro códigos de `ConfioSubscriptionInputError` NO son un solo bucket: dos
    // hablan del llamador y dos de NUESTRA configuración. Se mapea por `code`, nunca
    // por el texto del mensaje.
    it.each([
      ['invalid_buyer', 'buyer.email'],
      ['missing_buyer_or_plan', 'buyer'],
    ])('%s → 422 INVALID_BUYER con el `field` (culpa del llamador)', async (code, field) => {
      confio.createSubscription.mockRejectedValue(
        new ConfioSubscriptionInputError(code as any, field, 'llegó "roto@" y se esperaba otra cosa'),
      )

      const error = await alta().catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('INVALID_BUYER')
      expect(error.getResponse().field).toBe(field)
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      // El detalle lleva PII: nunca vuelve al cliente.
      expect(JSON.stringify(error.getResponse())).not.toContain('roto@')
    })

    it.each([
      ['plan_store_mismatch', 'planName', 'CONFIO_PLAN_STORE_MISMATCH'],
      ['invalid_subscription_name', 'name', 'CONFIO_SUBSCRIPTION_NAME_INVALID'],
    ])(
      '%s → 503 %s: es NUESTRA configuración, no algo que el cliente pueda arreglar',
      async (code, field, expected) => {
        confio.createSubscription.mockRejectedValue(
          new ConfioSubscriptionInputError(code as any, field, 'no pertenece al store configurado'),
        )

        const error = await alta().catch((e) => e)

        expect(error).toBeInstanceOf(RequestException)
        expect(error.code).toBe(expected)
        expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
        // No culpa al comprador ni reexpone el detalle del rechazo.
        expect(JSON.stringify(error.getResponse())).not.toContain('comprador')
        expect(JSON.stringify(error.getResponse())).not.toContain('store configurado')
      },
    )
  })

  describe('fetchAcceptance', () => {
    it('re-pide el link por el camino autenticado, a partir del `name` guardado', async () => {
      const result = await service.fetchAcceptance(CONFIO_SUB)

      expect(confio.getSubscription).toHaveBeenCalledWith(CONFIO_SUB)
      expect(result).toEqual({
        acceptanceUrl: ALTA.acceptanceUrl,
        status: 'PENDING_ACCEPTANCE',
        acceptanceExpireTime: ALTA.acceptanceExpireTime,
      })
    })

    it('un fallo de la pasarela al consultar también es 503, no un 500 opaco', async () => {
      confio.getSubscription.mockRejectedValue(new Error('timeout'))

      const error = await service.fetchAcceptance(CONFIO_SUB).catch((e) => e)

      expect(error.code).toBe('CONFIO_SUBSCRIPTION_UNAVAILABLE')
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    })
  })
})
