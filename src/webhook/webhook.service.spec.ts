// R6: Single-responsibility unit suite for WebhookService idempotency and Confio subscription event dispatch.
import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { getQueueToken } from '@nestjs/bullmq'
import { QueryFailedError } from 'typeorm'

import { WebhookService } from './webhook.service'
import { ConfioSubscriptionWebhookService } from './confio-subscription-webhook.service'
import { sumarUnCicloMensual } from './confio-period.util'
import { WebhookEvent, WebhookStatus } from './entities/webhookEvent.entity'
import { Payment, PaymentProvider } from '../payment/entities/payment.entity'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { ClientRolesService } from '../client/client-roles.service'

/**
 * Driver error shape for a duplicate insert on `webhook_events` (`code=23505`,
 * `constraint=UQ_webhook_events_provider_event`); TypeORM copies the driver
 * error properties onto `QueryFailedError`.
 */
function violacionDeUnico(): Error {
  const driverError: any = new Error(
    'duplicate key value violates unique constraint "UQ_webhook_events_provider_event"',
  )
  driverError.code = '23505'
  driverError.constraint = 'UQ_webhook_events_provider_event'
  driverError.severity = 'ERROR'
  return new QueryFailedError('INSERT INTO webhook_events', [], driverError)
}

/** Falla que NO es de unicidad: caída de conexión. */
function conexionCaida(): Error {
  const driverError: any = new Error('connection terminated unexpectedly')
  driverError.code = '08006'
  return new QueryFailedError('INSERT INTO webhook_events', [], driverError)
}

const EVENT_ID =
  'stores/s/subscription-plans/p/subscriptions/sub:subscription.billingStatusChanged:ciclo-3'

describe('WebhookService.receive', () => {
  let service: WebhookService
  let writeRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock }
  let readRepo: { findOne: jest.Mock }
  let paymentReadRepo: { findOne: jest.Mock }
  let queue: { add: jest.Mock }

  beforeEach(async () => {
    writeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d) => d),
      save: jest.fn((d) => Promise.resolve({ id: 'we-1', ...d })),
    }
    readRepo = { findOne: jest.fn().mockResolvedValue(null) }
    paymentReadRepo = { findOne: jest.fn() }
    queue = { add: jest.fn().mockResolvedValue(undefined) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(WebhookEvent, 'DBWrite'), useValue: writeRepo },
        { provide: getRepositoryToken(WebhookEvent, 'DBRead'), useValue: readRepo },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: paymentReadRepo },
        { provide: getQueueToken('webhook-retry'), useValue: queue },
        // El ramo firmado tiene su propio bloque más abajo, con el handler real.
        { provide: ConfioSubscriptionWebhookService, useValue: { handle: jest.fn() } },
        // R17: `receive` tests only Confio idempotency; Mercado Pago is not called.
        { provide: MercadoPagoProvider, useValue: { getNoticePayment: jest.fn() } },
      ],
    }).compile()

    service = module.get<WebhookService>(WebhookService)
  })

  function recibir() {
    return service.receive('confio', 'subscription.billingStatusChanged', EVENT_ID, { event: 'x' })
  }

  it('queries idempotency by provider and providerEventId against DBWrite, not DBRead', async () => {
    // R15: red if receive() drops provider from the lookup or queries DBRead instead of DBWrite.
    await recibir()

    expect(writeRepo.findOne).toHaveBeenCalledWith({
      where: { provider: 'confio', providerEventId: EVENT_ID },
    })
    expect(readRepo.findOne).not.toHaveBeenCalled()
  })

  it('descarta la reentrega que el chequeo previo ya encuentra', async () => {
    writeRepo.findOne.mockResolvedValue({ id: 'we-existente', providerEventId: EVENT_ID })

    const res = await recibir()

    expect(res).toEqual({
      data: { id: 'we-existente', providerEventId: EVENT_ID },
      duplicate: true,
    })
    expect(writeRepo.save).not.toHaveBeenCalled()
  })

  it('trata la violación del índice único como duplicado, no como fallo', async () => {
    // Dos entregas concurrentes: las dos pasan el chequeo previo y una pierde el insert.
    writeRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'we-ganador', providerEventId: EVENT_ID })
    writeRepo.save.mockRejectedValueOnce(violacionDeUnico())

    const res = await recibir()

    expect(res).toEqual({ data: { id: 'we-ganador', providerEventId: EVENT_ID }, duplicate: true })
    // Un solo `save`: el insert que perdió. Si hubiera despacho, `processEvent`
    // volvería a guardar el evento para marcarlo PROCESSING.
    expect(writeRepo.save).toHaveBeenCalledTimes(1)
  })

  it('deja fallar cualquier otro error de base', async () => {
    writeRepo.save.mockRejectedValueOnce(conexionCaida())

    const res = await recibir()

    expect(res).toHaveProperty('error')
    expect((res as { duplicate?: boolean }).duplicate).toBeUndefined()
  })
})

// ============================================================================
// Ramo firmado de ConfioPagos: los dos eventos `subscription.*`
// ============================================================================

/**
 * Payloads copiados de `src/provider/confio/confio-webhook.spec.ts`, que a su
 * vez los vendorizó de `CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks. No inventados:
 * el cobro exitoso trae `payment`, el fallido lo cambia por `failedCount`.
 */
const SUB_NAME =
  'stores/01KZBY100Z3HD2X997XE0DN8PW/subscription-plans/01M0Z020DYMXKKDHHR4HAX916R/subscriptions/01M0Z0AAAA'

const SUB_ID = '11111111-1111-4111-8111-111111111111'

function cobro(status: string, over: Record<string, any> = {}): any {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUB_NAME,
      cycleNumber: 3,
      amountCents: 1990000,
      currencyCode: 'COP',
      status,
      createTime: '2026-01-14T10:00:00Z',
      ...(status === 'SUCCEEDED'
        ? { payment: 'organizations/o/stores/s/payments/p3' }
        : { failedCount: 1, reason: 'INSUFFICIENT_FUNDS' }),
      ...over,
    },
    timestamp: 1768384800,
    signature: { properties: ['name', 'status'], checksum: '4F6A' },
  }
}

function cambioDeEstado(status: string, over: Record<string, any> = {}): any {
  return {
    event: 'subscription.subscriptionStatusChanged',
    data: {
      name: SUB_NAME,
      status,
      createTime: '2026-01-01T10:00:00Z',
      updateTime: '2026-02-14T10:00:00Z',
      ...over,
    },
    timestamp: 1768384800,
    signature: { properties: ['name', 'status'], checksum: '4F6A' },
  }
}

/**
 * El mes siguiente se calcula con la MISMA función que usa el código
 * (`sumarUnCicloMensual`), no con una réplica: duplicar la aritmética de fechas
 * en el test haría que ambos coincidan en el error el día que alguien cambie la
 * regla —fin de mes, años bisiestos— y el caso dejaría de cuidar nada.
 */
const unMesDespues = (d: Date) => sumarUnCicloMensual(d)

/** Fin de período vigente (a futuro), base de los casos de avance local. */
const FIN_ANTERIOR = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)

function suscripcion(over: Record<string, any> = {}): any {
  return {
    id: SUB_ID,
    brandId: 'brand-1',
    userId: 'user-1',
    planSlug: 'dropi-roax',
    status: SubscriptionStatus.ACTIVE,
    provider: SubscriptionProvider.CONFIO,
    providerSubscriptionId: SUB_NAME,
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    // A futuro y relativo: `periodoLocal` tiene PISO en el ahora (un
    // `nextBillingDate` en el pasado despertaría el cron de cobros), así que un
    // literal vencido haría caer estos casos al piso en vez de ejercitar la rama
    // «avanza desde el fin anterior» — y el día que la fecha quede atrás, el test
    // se rompe solo sin que nada haya cambiado.
    currentPeriodEnd: FIN_ANTERIOR,
    nextBillingDate: FIN_ANTERIOR,
    retryCount: 2,
    cancelledAt: null,
    ...over,
  }
}

describe('WebhookService — ramo de suscripción de ConfioPagos', () => {
  let service: WebhookService
  let writeRepo: any
  let paymentReadRepo: { findOne: jest.Mock }
  let subRepo: { findOne: jest.Mock }
  let eventRepo: { createQueryBuilder: jest.Mock }
  let manager: any
  let confio: { getSubscription: jest.Mock }
  let roles: Record<string, jest.Mock>
  let checkout: { completeExternalPayment: jest.Mock }
  let warn: jest.SpyInstance

  /** Query builder encadenable: lo único que se le pide es `getOne()`. */
  function qb(resultado: any) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(resultado),
    }
  }

  beforeEach(async () => {
    writeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d) => d),
      save: jest.fn((d) => Promise.resolve({ id: 'we-1', ...d })),
    }
    // R17: In-memory stub for Payment read repository in this unit suite; SQL queries run in e2e.
    paymentReadRepo = { findOne: jest.fn().mockResolvedValue(null) }
    subRepo = { findOne: jest.fn().mockResolvedValue(null) }
    eventRepo = { createQueryBuilder: jest.fn(() => qb(null)) }
    manager = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((...args: any[]) => Promise.resolve(args[args.length - 1])),
      createQueryBuilder: jest.fn(() => qb(null)),
    }
    confio = { getSubscription: jest.fn() }
    roles = {
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      renewPlanForBrand: jest.fn().mockResolvedValue(true),
    }
    checkout = { completeExternalPayment: jest.fn().mockResolvedValue(undefined) }

    const dataSource = { transaction: jest.fn((cb: any) => cb(manager)) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        ConfioSubscriptionWebhookService,
        { provide: getRepositoryToken(WebhookEvent, 'DBWrite'), useValue: writeRepo },
        { provide: getRepositoryToken(WebhookEvent, 'DBRead'), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: paymentReadRepo },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: eventRepo },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        { provide: ConfioProvider, useValue: confio },
        // R17: Only Confio subscription webhooks run in this block; Mercado Pago is not called.
        { provide: MercadoPagoProvider, useValue: { getNoticePayment: jest.fn() } },
        // El corte de acceso en roles tiene su propio spec
        // (`confio-subscription-webhook.service.spec.ts`); acá el canal responde
        // OK para que estos casos midan sólo el estado local.
        { provide: ClientRolesService, useValue: roles },
        { provide: getQueueToken('webhook-retry'), useValue: { add: jest.fn() } },
      ],
    }).compile()

    service = module.get<WebhookService>(WebhookService)
    service.setCheckoutService(checkout)
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  /** Fila de `subscriptions` que quedó guardada dentro de la transacción. */
  function suscripcionGuardada(): any {
    const call = manager.save.mock.calls.find((c: any[]) => c[0] !== SubscriptionEvent)
    return call?.[0]
  }

  /** Filas de historial escritas (`subscription_events`). */
  function historial(): any[] {
    return manager.save.mock.calls
      .filter((c: any[]) => c[0] === SubscriptionEvent)
      .map((c: any[]) => c[1])
  }

  function evento(payload: any, providerEventId = 'ev-1'): any {
    return {
      id: 'we-1',
      provider: 'confio',
      eventType: payload.event,
      providerEventId,
      payload,
      status: WebhookStatus.RECEIVED,
      retryCount: 0,
    }
  }

  function despachar(payload: any, providerEventId = 'ev-1') {
    return service['processEvent'](evento(payload, providerEventId))
  }

  function conSuscripcion(sub: any) {
    subRepo.findOne.mockResolvedValue(sub)
    manager.findOne.mockResolvedValue(sub)
    return sub
  }

  // ---------------------------------------------------------------- mapa (4)
  describe('subscription.subscriptionStatusChanged', () => {
    const casos: Array<[string, SubscriptionStatus]> = [
      ['TRIALING', SubscriptionStatus.TRIAL],
      ['ACTIVE', SubscriptionStatus.ACTIVE],
      ['PAST_DUE', SubscriptionStatus.PAST_DUE],
      ['SUSPENDED', SubscriptionStatus.PAST_DUE],
      ['CANCELED', SubscriptionStatus.CANCELLED],
      ['EXPIRED', SubscriptionStatus.EXPIRED],
    ]

    it.each(casos)('mapea %s → %s y deja una sola fila de historial', async (wire, local) => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.TRIAL }))

      await despachar(cambioDeEstado(wire))

      expect(suscripcionGuardada().status).toBe(local)
      const filas = historial()
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({
        subscriptionId: SUB_ID,
        fromStatus: SubscriptionStatus.TRIAL,
        toStatus: local,
        triggeredBy: 'confio-webhook',
      })
      expect(filas[0].metadata).toMatchObject({
        event: 'subscription.subscriptionStatusChanged',
        providerEventId: 'ev-1',
      })
    })

    it('CANCELED sella cancelledAt cuando venía nulo', async () => {
      conSuscripcion(suscripcion({ cancelledAt: null }))

      await despachar(cambioDeEstado('CANCELED'))

      expect(suscripcionGuardada().cancelledAt).toBeInstanceOf(Date)
    })

    it('CANCELED no pisa un cancelledAt existente', async () => {
      const previo = new Date('2026-01-05T00:00:00Z')
      conSuscripcion(suscripcion({ cancelledAt: previo }))

      await despachar(cambioDeEstado('CANCELED'))

      expect(suscripcionGuardada().cancelledAt).toBe(previo)
    })

    it.each(['PENDING_ACCEPTANCE', 'PROCESSING'])(
      '%s no cambia el estado ni escribe',
      async (wire) => {
        conSuscripcion(suscripcion())

        await despachar(cambioDeEstado(wire))

        expect(manager.save).not.toHaveBeenCalled()
        expect(historial()).toHaveLength(0)
      },
    )

    it('un estado desconocido se loguea, no escribe y no lanza', async () => {
      conSuscripcion(suscripcion())

      await expect(despachar(cambioDeEstado('SOMETHING_NEW'))).resolves.toBeUndefined()

      expect(manager.save).not.toHaveBeenCalled()
    })

    it('avisa cuando revive una suscripción cancelada', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.CANCELLED }))

      await despachar(cambioDeEstado('ACTIVE'))

      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
      expect(warn.mock.calls.flat().join(' ')).toMatch(/cancelled.*active|active.*cancelled/)
    })
  })

  // Fechas del proveedor RELATIVAS al ahora, no literales. El handler descarta a
  // propósito un período ya vencido (`confio-period.util.ts`: no sirve ni como
  // `expiresAt` —roles lo barre— ni como `nextBillingDate`), así que un literal
  // como '2026-02-05' hace pasar el test el día que se escribe y lo rompe cuando
  // esa fecha queda atrás. Estos tres se mantienen siempre a futuro.
  const DIA = 24 * 60 * 60 * 1000
  const periodoRemoto = () => ({
    currentPeriodStart: new Date(Date.now() - 5 * DIA),
    currentPeriodEnd: new Date(Date.now() + 25 * DIA),
    nextBillingTime: new Date(Date.now() + 26 * DIA),
  })

  // ------------------------------------------------------------- cobro (2/3)
  describe('subscription.billingStatusChanged', () => {
    it('SUCCEEDED con respuesta del proveedor toma sus tres fechas', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      // Fechas a propósito DISTINTAS del avance local (02-01 → 03-01): si el
      // handler ignorara al proveedor, este test seguiría verde.
      const remoto = periodoRemoto()
      confio.getSubscription.mockResolvedValue(remoto)

      await despachar(cobro('SUCCEEDED'))

      const guardada = suscripcionGuardada()
      expect(guardada.status).toBe(SubscriptionStatus.ACTIVE)
      expect(guardada.retryCount).toBe(0)
      expect(guardada.currentPeriodStart).toEqual(remoto.currentPeriodStart)
      expect(guardada.currentPeriodEnd).toEqual(remoto.currentPeriodEnd)
      expect(guardada.nextBillingDate).toEqual(remoto.nextBillingTime)
      // Acotado a `metadata.roles`, que es lo que este caso declara: que el
      // `expiresAt` prometido a roles sea EXACTAMENTE el período que se persiste.
      // El resto del `metadata` lo cubre —con `toEqual` exhaustivo— el primer
      // test de `la traza del movimiento…` en
      // `confio-subscription-webhook.service.spec.ts`, dueño único de esa forma
      // desde `trazabilidad-de-movimientos`. No se afloja a `toMatchObject`.
      expect(historial()[0].metadata.roles).toEqual({
        accion: 'reponer',
        brandId: 'brand-1',
        planSlug: 'dropi-roax',
        expiresAt: remoto.currentPeriodEnd.toISOString(),
      })
    })

    it('SUCCEEDED con el proveedor caído avanza un ciclo local desde el fin anterior', async () => {
      conSuscripcion(suscripcion())
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cobro('SUCCEEDED'))

      const guardada = suscripcionGuardada()
      expect(guardada.status).toBe(SubscriptionStatus.ACTIVE)
      expect(guardada.currentPeriodStart).toEqual(FIN_ANTERIOR)
      expect(guardada.currentPeriodEnd).toEqual(unMesDespues(FIN_ANTERIOR))
      expect(guardada.nextBillingDate).toEqual(unMesDespues(FIN_ANTERIOR))
      // Acotado a `metadata.roles`, que es lo que este caso declara: que el
      // `expiresAt` prometido a roles sea EXACTAMENTE el período que se persiste.
      // El resto del `metadata` lo cubre —con `toEqual` exhaustivo— el primer
      // test de `la traza del movimiento…` en
      // `confio-subscription-webhook.service.spec.ts`, dueño único de esa forma
      // desde `trazabilidad-de-movimientos`. No se afloja a `toMatchObject`.
      expect(historial()[0].metadata.roles).toEqual({
        accion: 'reponer',
        brandId: 'brand-1',
        planSlug: 'dropi-roax',
        expiresAt: unMesDespues(FIN_ANTERIOR).toISOString(),
      })
    })

    it('SUCCEEDED sin las tres fechas del proveedor también avanza localmente', async () => {
      conSuscripcion(suscripcion())
      // Respuesta PARCIAL: se descarta entera, no se mezcla con el avance local.
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-02-05T00:00:00Z'),
        currentPeriodEnd: new Date('2026-03-05T00:00:00Z'),
        nextBillingTime: undefined,
      })

      await despachar(cobro('SUCCEEDED'))

      const guardada = suscripcionGuardada()
      expect(guardada.currentPeriodStart).toEqual(FIN_ANTERIOR)
      expect(guardada.currentPeriodEnd).toEqual(unMesDespues(FIN_ANTERIOR))
      expect(guardada.nextBillingDate).toEqual(unMesDespues(FIN_ANTERIOR))
    })

    it.each(['FAILED', 'SOMETHING_NEW'])(
      '%s deja past_due sin avanzar el período',
      async (status) => {
        conSuscripcion(suscripcion())

        await despachar(cobro(status))

        const guardada = suscripcionGuardada()
        expect(guardada.status).toBe(SubscriptionStatus.PAST_DUE)
        expect(guardada.currentPeriodEnd).toEqual(FIN_ANTERIOR)
        expect(guardada.nextBillingDate).toEqual(FIN_ANTERIOR)
        expect(confio.getSubscription).not.toHaveBeenCalled()
        expect(historial()[0].metadata).toMatchObject({
          event: 'subscription.billingStatusChanged',
          providerEventId: 'ev-1',
          cycleNumber: 3,
        })
      },
    )
  })

  // ------------------------------------------------------------ resolución (1)
  describe('resolución de la suscripción', () => {
    it('resolves by providerSubscriptionId === data.name and provider === confio', async () => {
      // R15: red if resolverSuscripcion omits provider: SubscriptionProvider.CONFIO when querying by providerSubscriptionId.
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado('EXPIRED'))

      expect(subRepo.findOne).toHaveBeenCalledWith({
        where: {
          provider: SubscriptionProvider.CONFIO,
          providerSubscriptionId: SUB_NAME,
        },
      })
    })

    it('cae al correlationId cuando es un UUID y el name no resuelve', async () => {
      const sub = suscripcion({ providerSubscriptionId: null })
      subRepo.findOne.mockResolvedValueOnce(null).mockResolvedValue(sub)
      manager.findOne.mockResolvedValue(sub)

      await despachar(cambioDeEstado('EXPIRED', { correlationId: SUB_ID }))

      expect(subRepo.findOne).toHaveBeenCalledWith({
        where: { id: SUB_ID, provider: SubscriptionProvider.CONFIO },
      })
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.EXPIRED)
    })

    it('rejects correlationId fallback when the subscription belongs to another provider or another Confio resource name', async () => {
      // R15: red if resolverSuscripcion allows correlationId fallback onto a non-Confio subscription or a Confio subscription with another providerSubscriptionId.
      const otherProviderSub = suscripcion({
        id: SUB_ID,
        provider: SubscriptionProvider.STRIPE,
        providerSubscriptionId: null,
      })
      subRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(otherProviderSub)

      await despachar(cambioDeEstado('CANCELED', { correlationId: SUB_ID }))

      expect(manager.save).not.toHaveBeenCalled()
      expect(roles.removePlanFromBrand).not.toHaveBeenCalled()

      const mismatchedNameSub = suscripcion({
        id: SUB_ID,
        provider: SubscriptionProvider.CONFIO,
        providerSubscriptionId: 'stores/s/subscription-plans/p/subscriptions/other-sub',
      })
      subRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(mismatchedNameSub)

      await despachar(cambioDeEstado('CANCELED', { correlationId: SUB_ID }))

      expect(manager.save).not.toHaveBeenCalled()
      expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
    })

    it('prefers sub.providerSubscriptionId over data.name when reading the remote period', async () => {
      // R15: red if leerPeriodoDelProveedor prefers data.name over sub.providerSubscriptionId.
      const sub = suscripcion({
        providerSubscriptionId: SUB_NAME,
      })
      confio.getSubscription.mockResolvedValue({})

      await (service['confioSubscriptions'] as any).leerPeriodoDelProveedor(
        { name: 'stores/s/subscription-plans/p/subscriptions/attacker-resource' },
        sub,
      )

      expect(confio.getSubscription).toHaveBeenCalledWith(SUB_NAME)
    })

    it('un correlationId que no es UUID nunca llega al repositorio', async () => {
      await despachar(cambioDeEstado('EXPIRED', { name: undefined, correlationId: 'brand-42' }))

      expect(subRepo.findOne).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('sin suscripción: loguea name y correlationId, no lanza y el evento queda processed', async () => {
      const e = evento(cambioDeEstado('EXPIRED', { correlationId: SUB_ID }))

      await expect(service['processEvent'](e)).resolves.toBeUndefined()

      expect(manager.save).not.toHaveBeenCalled()
      expect(e.status).toBe(WebhookStatus.PROCESSED)
      const texto = warn.mock.calls.flat().join(' ')
      expect(texto).toContain(SUB_NAME)
      expect(texto).toContain(SUB_ID)
    })

    it('resuelto por correlationId, el cobro consulta el resource name de la fila', async () => {
      conSuscripcion(suscripcion())
      confio.getSubscription.mockResolvedValue({})

      await despachar(cobro('SUCCEEDED', { name: undefined, correlationId: SUB_ID }))

      expect(confio.getSubscription).toHaveBeenCalledWith(SUB_NAME)
    })

    it('sin resource name en ninguna punta no se llama al proveedor', async () => {
      conSuscripcion(suscripcion({ providerSubscriptionId: null }))

      await despachar(cobro('SUCCEEDED', { name: undefined, correlationId: SUB_ID }))

      expect(confio.getSubscription).not.toHaveBeenCalled()
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
    })
  })

  // ----------------------------------------------------------- idempotencia (6)
  describe('idempotencia del re-despacho', () => {
    it('el marcador previo corta antes de consultar al proveedor', async () => {
      conSuscripcion(suscripcion())
      eventRepo.createQueryBuilder.mockReturnValue(qb({ id: 'se-previo' }))

      await despachar(cobro('SUCCEEDED'))

      expect(confio.getSubscription).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('el marcador dentro de la transacción corta aunque el previo no lo viera', async () => {
      conSuscripcion(suscripcion())
      confio.getSubscription.mockResolvedValue({})
      manager.createQueryBuilder.mockReturnValue(qb({ id: 'se-previo' }))

      await despachar(cobro('SUCCEEDED'))

      expect(manager.save).not.toHaveBeenCalled()
      expect(historial()).toHaveLength(0)
    })

    it('checks both the signed-timestamp key and the pre-deploy legacy updateTime key for subscriptionStatusChanged', async () => {
      // R15: red if buscarMarcador omits buildLegacyConfioStatusChangedEventId when checking SubscriptionEvent markers.
      conSuscripcion(suscripcion())
      const builder = qb({ id: 'se-legacy' })
      eventRepo.createQueryBuilder.mockReturnValue(builder)
      const payload = cambioDeEstado('PAST_DUE')
      const newEventId = `${SUB_NAME}:subscription.subscriptionStatusChanged:PAST_DUE:1768384800`
      const legacyEventId = `${SUB_NAME}:subscription.subscriptionStatusChanged:PAST_DUE:2026-02-14T10:00:00Z`

      await despachar(payload, newEventId)

      expect(builder.andWhere).toHaveBeenCalledWith(
        "e.metadata ->> 'providerEventId' IN (:...pids)",
        { pids: [newEventId, legacyEventId] },
      )
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('relee la fila bloqueada con pessimistic_write', async () => {
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado('EXPIRED'))

      expect(manager.findOne).toHaveBeenCalledWith(Subscription, {
        where: { id: SUB_ID },
        lock: { mode: 'pessimistic_write' },
      })
    })
  })

  describe('provider-scoped payment dispatch (Layer 1)', () => {
    const PAY_UUID = '22222222-2222-4222-8222-222222222222'

    it('routes a Confio one-shot payment notice through the legacy status path when the payment belongs to Confio', async () => {
      // R15: red if dispatchEvent stops routing Confio one-shot notices when ConfioProvider.isCompleted(data.status) is true.
      paymentReadRepo.findOne.mockImplementation(async ({ where }: any) => {
        if (where?.id === PAY_UUID && where?.provider === PaymentProvider.CONFIO) {
          return {
            id: PAY_UUID,
            provider: PaymentProvider.CONFIO,
            providerPaymentId: 'stores/s/payments/p',
          }
        }
        return null
      })

      await despachar({
        event: 'payment.statusChanged',
        data: { name: 'stores/s/payments/p', status: 'FUNDED', correlationId: PAY_UUID },
      })

      expect(checkout.completeExternalPayment).toHaveBeenCalledWith(
        PAY_UUID,
        expect.any(Object),
        PaymentProvider.CONFIO,
      )
      expect(subRepo.findOne).not.toHaveBeenCalled()
    })

    it('does not call completeExternalPayment when a Confio one-shot notice targets a payment of another provider or mismatched providerPaymentId', async () => {
      // R15: red if findPaymentByProviderIds or findPaymentByCorrelationId omits the provider === PaymentProvider.CONFIO or providerPaymentId check.
      paymentReadRepo.findOne.mockImplementation(async ({ where }: any) => {
        if (where?.providerPaymentId === 'stores/s/payments/p') {
          return null
        }
        return {
          id: PAY_UUID,
          provider: PaymentProvider.STRIPE,
          providerPaymentId: 'cs_live_1',
        }
      })

      await despachar({
        event: 'payment.statusChanged',
        data: { name: 'stores/s/payments/p', status: 'FUNDED', correlationId: PAY_UUID },
      })

      expect(checkout.completeExternalPayment).not.toHaveBeenCalled()

      paymentReadRepo.findOne.mockResolvedValue({
        id: PAY_UUID,
        provider: PaymentProvider.CONFIO,
        providerPaymentId: 'stores/s/payments/other-payment',
      })

      await despachar({
        event: 'payment.statusChanged',
        data: { name: 'stores/s/payments/p', status: 'FUNDED', correlationId: PAY_UUID },
      })

      expect(checkout.completeExternalPayment).not.toHaveBeenCalled()
    })

    it('does not call completeExternalPayment when a Dropi notice targets a non-Dropi payment', async () => {
      // R15: red if findPaymentByProviderIds omits the provider === PaymentProvider.DROPI filter on Dropi notices.
      paymentReadRepo.findOne.mockResolvedValue({
        id: PAY_UUID,
        provider: PaymentProvider.CONFIO,
        providerPaymentId: 'dropi-ch-1',
      })

      await service['processEvent']({
        id: 'we-dropi-1',
        provider: 'dropi',
        eventType: 'charge.completed',
        providerEventId: 'dropi-ev-1',
        payload: { chargeId: 'dropi-ch-1', amount: 100000 },
        status: WebhookStatus.RECEIVED,
        retryCount: 0,
      } as any)

      expect(paymentReadRepo.findOne).toHaveBeenCalledWith({
        where: { providerPaymentId: 'dropi-ch-1', provider: PaymentProvider.DROPI },
      })
      expect(checkout.completeExternalPayment).not.toHaveBeenCalled()
    })

    it('does not call completeExternalPayment on Stripe checkout.session.completed when payment_status is not paid, and ignores metadata.paymentId', async () => {
      // R15: red if dispatchEvent omits the payment_status !== 'paid' guard or resolves Stripe sessions via metadata.paymentId.
      paymentReadRepo.findOne.mockResolvedValue({
        id: PAY_UUID,
        provider: PaymentProvider.STRIPE,
        providerPaymentId: 'cs_test_unpaid',
      })

      await service['processEvent']({
        id: 'we-stripe-unpaid',
        provider: 'stripe',
        eventType: 'checkout.session.completed',
        providerEventId: 'evt_unpaid',
        payload: {
          data: {
            object: {
              id: 'cs_test_unpaid',
              payment_status: 'unpaid',
              amount_total: 10000,
              metadata: { paymentId: PAY_UUID },
            },
          },
        },
        status: WebhookStatus.RECEIVED,
        retryCount: 0,
      } as any)

      expect(checkout.completeExternalPayment).not.toHaveBeenCalled()

      // Paid session, but session.id does not match any Stripe payment (even though metadata.paymentId is set):
      paymentReadRepo.findOne.mockResolvedValue(null)

      await service['processEvent']({
        id: 'we-stripe-paid-forged-meta',
        provider: 'stripe',
        eventType: 'checkout.session.completed',
        providerEventId: 'evt_paid_forged',
        payload: {
          data: {
            object: {
              id: 'cs_unknown',
              payment_status: 'paid',
              amount_total: 10000,
              metadata: { paymentId: PAY_UUID },
            },
          },
        },
        status: WebhookStatus.RECEIVED,
        retryCount: 0,
      } as any)

      expect(paymentReadRepo.findOne).toHaveBeenCalledWith({
        where: { providerPaymentId: 'cs_unknown', provider: PaymentProvider.STRIPE },
      })
      expect(checkout.completeExternalPayment).not.toHaveBeenCalled()
    })
  })
})
