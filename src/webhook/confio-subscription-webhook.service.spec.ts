import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { getQueueToken } from '@nestjs/bullmq'

import { ConfioSubscriptionWebhookService } from './confio-subscription-webhook.service'
import { WebhookService } from './webhook.service'
import { WebhookEvent, WebhookStatus } from './entities/webhookEvent.entity'
import { Payment } from '../payment/entities/payment.entity'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ClientRolesService } from '../client/client-roles.service'

/**
 * Corte y reposición del acceso pro en `backend-roles` según el resultado del
 * cobro que reporta ConfioPagos (épica 002, `corte-de-acceso-al-primer-fallo`).
 *
 * Payloads copiados de `src/provider/confio/confio-webhook.spec.ts`, que a su vez
 * los vendorizó de `CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks: el cobro exitoso
 * trae `payment`, el fallido lo cambia por `failedCount`. No inventados.
 *
 * Nota sobre la reposición: `assignPlanToBrand` repetido NO es un problema del
 * lado de roles —`assignPlanToBrandBySlug`
 * (`backend-roles/src/data/brand-permission/brand-permission.service.ts:529`) es
 * un upsert: actualiza `expiresAt` si el vínculo ya existe—. `renewPlanForBrand`
 * sí lo sería: su handler tira 404 cuando la marca no tiene el plan, que es
 * exactamente el estado en el que queda tras el retiro.
 */
const SUB_NAME =
  'stores/01KZBY100Z3HD2X997XE0DN8PW/subscription-plans/01M0Z020DYMXKKDHHR4HAX916R/subscriptions/01M0Z0AAAA'

/**
 * Reloj fijo, dentro del período que la suscripción de prueba tiene vigente
 * (`currentPeriodEnd` = 2026-02-01). El avance local tiene PISO en el ahora, así
 * que sin fijar el reloj los casos de renovación normal dependerían de la fecha
 * en que corren los tests. Los casos de recuperación tardía lo mueven a mano con
 * `relojEn`.
 */
const AHORA = '2026-01-14T10:00:00Z'

const SUB_ID = '11111111-1111-4111-8111-111111111111'
const BRAND_ID = 'brand-1'
const PLAN_SLUG = 'dropi-roax'

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

function suscripcion(over: Record<string, any> = {}): any {
  return {
    id: SUB_ID,
    brandId: BRAND_ID,
    userId: 'user-1',
    planSlug: PLAN_SLUG,
    status: SubscriptionStatus.ACTIVE,
    provider: SubscriptionProvider.CONFIO,
    providerSubscriptionId: SUB_NAME,
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    nextBillingDate: new Date('2026-02-01T00:00:00Z'),
    retryCount: 2,
    autoRenew: true,
    cancelledAt: null,
    ...over,
  }
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

/** Query builder encadenable: lo único que se le pide es `getOne()`. */
function qb(resultado: any) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(resultado),
  }
}

describe('ConfioSubscriptionWebhookService — acceso en roles según el cobro', () => {
  let service: ConfioSubscriptionWebhookService
  let subRepo: { findOne: jest.Mock }
  let eventRepo: { createQueryBuilder: jest.Mock }
  let manager: any
  let dataSource: { transaction: jest.Mock }
  let confio: { getSubscription: jest.Mock }
  let roles: {
    assignPlanToBrand: jest.Mock
    removePlanFromBrand: jest.Mock
    renewPlanForBrand: jest.Mock
  }

  beforeEach(async () => {
    subRepo = { findOne: jest.fn().mockResolvedValue(null) }
    eventRepo = { createQueryBuilder: jest.fn(() => qb(null)) }
    manager = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((...args: any[]) => Promise.resolve(args[args.length - 1])),
      createQueryBuilder: jest.fn(() => qb(null)),
    }
    dataSource = { transaction: jest.fn((cb: any) => cb(manager)) }
    confio = { getSubscription: jest.fn() }
    roles = {
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      renewPlanForBrand: jest.fn().mockResolvedValue(true),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfioSubscriptionWebhookService,
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: eventRepo },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        { provide: ConfioProvider, useValue: confio },
        { provide: ClientRolesService, useValue: roles },
      ],
    }).compile()

    service = module.get<ConfioSubscriptionWebhookService>(ConfioSubscriptionWebhookService)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    // Después de compilar el módulo, y sin tocar la maquinaria async de Node:
    // lo único que hace falta es que `new Date()` sea determinístico.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'], now: new Date(AHORA) })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  /** Mueve el reloj: los casos de recuperación tardía viven en otro mes. */
  function relojEn(iso: string) {
    jest.setSystemTime(new Date(iso))
  }

  /** Fila de `subscriptions` guardada dentro de la transacción. */
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

  function conSuscripcion(sub: any) {
    subRepo.findOne.mockResolvedValue(sub)
    manager.findOne.mockResolvedValue(sub)
    return sub
  }

  function despachar(payload: any, providerEventId = 'ev-1') {
    return service.handle(evento(payload, providerEventId))
  }

  // ------------------------------------------------------- (1) cobro fallido
  describe('el cobro fallido retira el plan', () => {
    it('un cobro no exitoso retira el plan de la suscripción, no `free`', async () => {
      conSuscripcion(suscripcion())

      await despachar(cobro('FAILED'))

      expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
      expect(roles.removePlanFromBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG)
      // Degradar a `free` es de `degradacion-a-free-y-baja-en-roles`, no de acá.
      expect(roles.removePlanFromBrand).not.toHaveBeenCalledWith(expect.anything(), 'free')
      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(roles.renewPlanForBrand).not.toHaveBeenCalled()
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.PAST_DUE)
    })

    it('deja la traza del retiro en la fila de historial ya emitida', async () => {
      conSuscripcion(suscripcion())

      await despachar(cobro('FAILED'))

      // Acotado a `metadata.roles`, que es su propósito declarado: el resto del
      // `metadata` lo cubre —y con `toEqual` EXHAUSTIVO— el primer test de
      // `la traza del movimiento…`, que asumió ese rol al agregarse los campos de
      // `trazabilidad-de-movimientos`. No se afloja a `toMatchObject`: el candado
      // contra volcar campos no decididos en un objeto que se sirve por API sigue
      // existiendo, sólo que en un solo lugar.
      expect(historial()[0].metadata.roles).toEqual({
        accion: 'retirar',
        brandId: BRAND_ID,
        planSlug: PLAN_SLUG,
        expiresAt: undefined,
      })
    })

    it.each(['PAST_DUE', 'SUSPENDED'])('el cambio de estado a %s también retira', async (wire) => {
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado(wire))

      expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
      expect(roles.removePlanFromBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG)
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.PAST_DUE)
    })

    // La mora NO degrada (aceptación 3): `past_due` retira el plan pago y NADA
    // más. Poner `free` acá convertiría un primer cobro fallido —recuperable por
    // definición— en una baja de plan.
    it.each(['PAST_DUE', 'SUSPENDED'])('el cambio de estado a %s NO asigna free', async (wire) => {
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado(wire))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.PAST_DUE)
      // La mora tampoco apaga la renovación: si un cobro posterior entra, vuelve.
      expect(suscripcionGuardada().autoRenew).toBe(true)
    })

    it('el cobro fallido tampoco asigna free ni apaga la renovación', async () => {
      conSuscripcion(suscripcion())

      await despachar(cobro('FAILED'))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(suscripcionGuardada().autoRenew).toBe(true)
    })

    it('una suscripción sin planSlug no pega en roles con un slug vacío', async () => {
      conSuscripcion(suscripcion({ planSlug: '' }))

      await despachar(cobro('FAILED'))

      expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.PAST_DUE)
    })
  })

  // ------------------------------------------- (1b) degradación a free y baja
  /**
   * `degradacion-a-free-y-baja-en-roles` (épica 002, criterio 3): un estado
   * TERMINAL reportado por ConfioPagos —cancelada o vencida— es «no hay cobro
   * posible», y ahí la marca pierde el plan pago Y recibe `free`. Es el escalón
   * siguiente de la mora, que sólo retira.
   *
   * Rojo si: se quita `assignPlanToBrand(brandId, FREE_PLAN_SLUG)` de
   * `downgradeBrandToFree` (la mutación de control declarada por la tarea).
   */
  describe('un estado terminal degrada la marca a free', () => {
    it.each([
      ['CANCELED', SubscriptionStatus.CANCELLED],
      ['EXPIRED', SubscriptionStatus.EXPIRED],
    ])('%s saca el plan pago y deja free', async (wire, esperado) => {
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado(wire as string))

      expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
      expect(roles.removePlanFromBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG)
      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(BRAND_ID, 'free')
      // Aridad EXACTA: `free` va SIN `expiresAt` (aceptación 2). Un plan free no
      // se cobra, así que no tiene vencimiento que prometer; pasarle uno lo
      // dejaría barrido por el cron de roles y la marca sin NINGÚN plan.
      expect(roles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
      // Primero se saca el pago, recién después entra `free`.
      expect(roles.removePlanFromBrand.mock.invocationCallOrder[0]).toBeLessThan(
        roles.assignPlanToBrand.mock.invocationCallOrder[0],
      )
      // `renewPlanForBrand` tira 404 sobre una marca sin el plan: nunca acá.
      expect(roles.renewPlanForBrand).not.toHaveBeenCalled()

      const guardada = suscripcionGuardada()
      expect(guardada.status).toBe(esperado)
      // ⚠️ DINERO: sin apagar `autoRenew` la fila seguiría siendo elegible para
      // los crons de renovación, que emiten cobros por un segundo riel.
      expect(guardada.autoRenew).toBe(false)

      expect(historial()).toHaveLength(1)
      const fila = historial()[0]
      expect(fila.fromStatus).toBe(SubscriptionStatus.ACTIVE)
      expect(fila.toStatus).toBe(esperado)
      expect(fila.triggeredBy).toBe('confio-webhook')
      // El hecho que la degradó, identificable desde la fila sola (aceptación 1).
      expect(fila.reason).toEqual(expect.stringContaining(wire as string))
      expect(fila.metadata.roles.accion).toBe('degradar')
    })

    it('la reentrega del mismo providerEventId no vuelve a tocar roles', async () => {
      conSuscripcion(suscripcion())
      // Mismo doble realista que el test de guarda de la traza: los DOS builders,
      // porque el pre-chequeo usa el repo y la relectura bajo lock usa el manager.
      const buscador = () => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () =>
          historial().find((f: any) => f?.metadata?.providerEventId === 'ev-1') || null,
        ),
      })
      eventRepo.createQueryBuilder.mockImplementation(buscador)
      manager.createQueryBuilder.mockImplementation(buscador)

      await despachar(cambioDeEstado('CANCELED'))
      await despachar(cambioDeEstado('CANCELED'))

      expect(historial()).toHaveLength(1)
      expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
    })

    /**
     * La deduplicación por `providerEventId` NO cubre este caso: el id se acuña
     * con `resource:event:status:updateTime`, así que la secuencia normal
     * CANCELED→EXPIRED son DOS notificaciones distintas y las dos terminales.
     * Sin la guarda por ESTADO la segunda volvería a llamar a roles y escribiría
     * un segundo `subscription_event` sobre una suscripción ya muerta, que es lo
     * que prohíbe la aceptación 4.
     *
     * Rojo si: se quita `ESTADOS_TERMINALES.includes(sub.status)` de
     * `planearCambioDeEstado`.
     */
    it('EXPIRED después de CANCELED no vuelve a degradar ni escribe un segundo evento', async () => {
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado('CANCELED'), 'ev-cancel')
      await despachar(cambioDeEstado('EXPIRED'), 'ev-expire')

      expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
      expect(historial()).toHaveLength(1)
      expect(historial()[0].toStatus).toBe(SubscriptionStatus.CANCELLED)
    })

    it.each(['CANCELLED', 'EXPIRED'])(
      'una suscripción que ya está %s no se vuelve a degradar',
      async (estado) => {
        conSuscripcion(suscripcion({ status: SubscriptionStatus[estado] }))

        await despachar(cambioDeEstado('CANCELED'), 'ev-otro')

        expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
        expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
        expect(dataSource.transaction).not.toHaveBeenCalled()
      },
    )

    it('si roles rechaza el retiro no se asigna free ni se escribe nada', async () => {
      conSuscripcion(suscripcion())
      roles.removePlanFromBrand.mockResolvedValue(false)

      await expect(despachar(cambioDeEstado('CANCELED'))).rejects.toThrow(/roles/i)

      // Dejar el plan pago puesto Y `free` encima es peor que reintentar entero.
      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(dataSource.transaction).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('si roles rechaza la asignación de free tampoco se marca la baja', async () => {
      conSuscripcion(suscripcion())
      roles.assignPlanToBrand.mockResolvedValue(false)

      await expect(despachar(cambioDeEstado('EXPIRED'))).rejects.toThrow(/roles/i)

      expect(dataSource.transaction).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------- (1.b) el eco de nuestra propia baja
  /**
   * `SubscriptionService.cancel` cancela PRIMERO en ConfioPagos y ellos devuelven
   * el hecho por webhook: ese `CANCELED` describe la MISMA baja que nosotros ya
   * sellamos, no una decisión del proveedor.
   *
   * Sin distinguirlo, el corte diferido de `cancelar-marca-baja-al-fin-de-periodo`
   * quedaba anulado en su camino PRINCIPAL: la guarda de idempotencia terminal ya
   * no da corto (la fila se queda en `trial`/`active`), así que el webhook degradaba
   * a `free` segundos después de que la baja conservó el plan, escribía un SEGUNDO
   * `SubscriptionEvent` CANCELLED del mismo hecho y dejaba `status = cancelled` con
   * `accessEndsAt` NO nula — justo lo que la invariante de la columna prohíbe.
   *
   * Rojo si: se quita la guarda `bajaPendiente` de `planearCambioDeEstado`.
   */
  describe('el terminal que ConfioPagos devuelve detrás de NUESTRA baja no tiene efecto', () => {
    /** Fila tal cual la deja `cancel`: viva, sellada y con acceso pagado por delante. */
    const conBajaPendiente = (over: Record<string, any> = {}) =>
      suscripcion({
        cancelledAt: new Date('2026-01-14T09:59:00Z'),
        // Posterior a AHORA (2026-01-14): el acceso ya pagado sigue vigente.
        accessEndsAt: new Date('2026-02-01T00:00:00Z'),
        autoRenew: false,
        ...over,
      })

    it.each([['CANCELED'], ['EXPIRED']])(
      '%s sobre una baja pendiente no degrada, no mueve el estado y no deja traza',
      async (wire) => {
        conSuscripcion(conBajaPendiente())

        await despachar(cambioDeEstado(wire))

        expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
        expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
        // Ni fila ni historial: la degradación tiene UN dueño, el cron de retiro.
        expect(dataSource.transaction).not.toHaveBeenCalled()
        expect(manager.save).not.toHaveBeenCalled()
      },
    )

    /**
     * El predicado DISCRIMINA: lo que suprime el efecto no es «hay `cancelledAt`»
     * sino «todavía le debemos acceso». Con la fecha de corte ya vencida el webhook
     * degrada como siempre.
     */
    it('con el acceso ya vencido el mismo CANCELED sí degrada', async () => {
      conSuscripcion(conBajaPendiente({ accessEndsAt: new Date('2026-01-10T00:00:00Z') }))

      await despachar(cambioDeEstado('CANCELED'))

      expect(roles.removePlanFromBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG)
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(BRAND_ID, 'free')
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.CANCELLED)
    })

    /**
     * La otra mitad: un `SUCCEEDED` tardío (un link one-shot emitido ANTES de la
     * baja y pagado después, o un cobro en vuelo) no puede volver a comprar el plan.
     * La guarda de resurrección miraba sólo `status`, que con el corte diferido ya
     * no es terminal, así que reponía el acceso de una suscripción cancelada del
     * lado de ConfioPagos.
     *
     * Rojo si: `revive` vuelve a ser sólo `ESTADOS_TERMINALES.includes(sub.status)`.
     */
    it('un cobro exitoso tardío sobre una baja pendiente NO repone el plan en roles', async () => {
      conSuscripcion(conBajaPendiente())

      await despachar(cobro('SUCCEEDED'))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(roles.renewPlanForBrand).not.toHaveBeenCalled()
      // El hecho del cobro sí se registra: lo que no se concede es el acceso.
      expect(historial()).toHaveLength(1)
      expect(historial()[0].metadata.roles).toBeUndefined()
    })
  })

  /**
   * El `status` es texto de la red y el mapa de estados es un object literal: sin
   * `hasOwnProperty` una clave heredada del prototipo devuelve una FUNCIÓN (o
   * `Object.prototype` para `__proto__`), truthy, que pasa el guard de «no
   * mapeado» y termina asignada a `sub.status`, que es un enum de Postgres.
   *
   * Rojo si: se vuelve al acceso directo `CONFIO_SUBSCRIPTION_STATUS_MAP[wire]`.
   */
  describe('un estado que no está en el mapa nunca se aplica', () => {
    it.each([['constructor'], ['valueOf'], ['toString'], ['__proto__'], ['CANCELADA']])(
      'el status "%s" se descarta como no mapeado',
      async (wire) => {
        conSuscripcion(suscripcion())

        await despachar(cambioDeEstado(wire))

        expect(dataSource.transaction).not.toHaveBeenCalled()
        expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
        expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      },
    )
  })

  // --------------------------------------------------- (2) cobro exitoso
  describe('el cobro exitoso posterior repone el plan', () => {
    it('repone con el fin de período que da el proveedor', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      // Fechas a propósito DISTINTAS del avance local (02-01 → 03-01): si el
      // handler prometiera el avance local, este test se pondría rojo.
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-02-05T00:00:00Z'),
        currentPeriodEnd: new Date('2026-03-05T00:00:00Z'),
        nextBillingTime: new Date('2026-03-06T00:00:00Z'),
      })

      await despachar(cobro('SUCCEEDED'))

      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-03-05T00:00:00Z'),
      )
      // `renewPlanForBrand` tira 404 en roles cuando la marca no tiene el plan,
      // que es justo el estado que dejó el retiro: nunca se usa acá.
      expect(roles.renewPlanForBrand).not.toHaveBeenCalled()
      expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
    })

    it('con el proveedor sin período repone con el avance local, el MISMO que persiste', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      // Respuesta PARCIAL: se descarta entera y se avanza un ciclo local.
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-02-05T00:00:00Z'),
        currentPeriodEnd: new Date('2026-03-05T00:00:00Z'),
        nextBillingTime: undefined,
      })

      await despachar(cobro('SUCCEEDED'))

      const finLocal = new Date('2026-03-01T00:00:00Z')
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG, finLocal)
      // Lo prometido a roles y lo persistido son el mismo valor por construcción.
      expect(suscripcionGuardada().currentPeriodEnd).toEqual(finLocal)
      expect(roles.assignPlanToBrand.mock.calls[0][2]).toEqual(
        suscripcionGuardada().currentPeriodEnd,
      )
    })

    it('deja la traza de la reposición en la fila de historial', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cobro('SUCCEEDED'))

      expect(historial()[0].metadata.roles).toEqual({
        accion: 'reponer',
        brandId: BRAND_ID,
        planSlug: PLAN_SLUG,
        expiresAt: '2026-03-01T00:00:00.000Z',
      })
    })

    // El cobro fallido NO avanza el período, así que el reintento exitoso puede
    // caer más de un ciclo después del último período pagado. Si el avance local
    // se contara igual desde `currentPeriodEnd`, el `expiresAt` prometido saldría
    // VENCIDO: el vínculo nacería barrido por el cron de `backend-roles`
    // (`tasks.service.ts:71`) y el cliente que pagó no recuperaría el acceso.
    describe('la recuperación tardía nunca promete un vencimiento en el pasado', () => {
      it('el avance local arranca en el ahora cuando el período ya venció', async () => {
        relojEn('2026-05-20T00:00:00Z')
        conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
        confio.getSubscription.mockRejectedValue(new Error('502 confio'))

        await despachar(cobro('SUCCEEDED'))

        // Un mes desde el pago, no desde el 2026-02-01 que quedó sin cobrar.
        const fin = new Date('2026-06-20T00:00:00Z')
        expect(roles.assignPlanToBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG, fin)
        expect(roles.assignPlanToBrand.mock.calls[0][2].getTime()).toBeGreaterThan(Date.now())
        const guardada = suscripcionGuardada()
        expect(guardada.currentPeriodStart).toEqual(new Date('2026-05-20T00:00:00Z'))
        expect(guardada.currentPeriodEnd).toEqual(fin)
        // ⚠️ DINERO: un `nextBillingDate` en el pasado despierta a
        // `processSubscriptionRenewals`, que cobraría por un segundo riel.
        expect(guardada.nextBillingDate.getTime()).toBeGreaterThan(Date.now())
      })

      it('un período ya vencido del proveedor se descarta como si no lo hubiera dado', async () => {
        relojEn('2026-05-20T00:00:00Z')
        conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
        // Trío COMPLETO, pero de un ciclo que ya terminó: el proveedor puede ir
        // atrasado y prometerlo sería lo mismo que no reponer nada.
        confio.getSubscription.mockResolvedValue({
          currentPeriodStart: new Date('2026-02-05T00:00:00Z'),
          currentPeriodEnd: new Date('2026-03-05T00:00:00Z'),
          nextBillingTime: new Date('2026-03-06T00:00:00Z'),
        })

        await despachar(cobro('SUCCEEDED'))

        expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
          BRAND_ID,
          PLAN_SLUG,
          new Date('2026-06-20T00:00:00Z'),
        )
        expect(suscripcionGuardada().currentPeriodEnd).toEqual(new Date('2026-06-20T00:00:00Z'))
        expect(suscripcionGuardada().nextBillingDate.getTime()).toBeGreaterThan(Date.now())
      })
    })

    it.each([SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED])(
      'un cobro tardío sobre una suscripción %s no concede acceso',
      async (status) => {
        conSuscripcion(suscripcion({ status }))
        confio.getSubscription.mockRejectedValue(new Error('502 confio'))

        await despachar(cobro('SUCCEEDED'))

        // El mapeo de estado lo dicta la aceptación y se aplica; conceder pro por
        // el cobro de una suscripción muerta, no.
        expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
        expect(roles.renewPlanForBrand).not.toHaveBeenCalled()
        expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
        expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
        expect(historial()[0].metadata.roles).toBeUndefined()
      },
    )

    // La otra cara del `it.each` de arriba: `pending` es el alta PAGA que todavía no
    // pagó su primer ciclo, así que este `SUCCEEDED` NO es un cobro tardío sobre algo
    // muerto — es el cobro que la fila estaba esperando — y sí tiene que reponer.
    //
    // Rojo si: se agrega `SubscriptionStatus.PENDING` a `ESTADOS_TERMINALES`
    // (⇒ `revive = true` ⇒ el efecto sale con `roles: undefined` ⇒ la fila pasa a
    // `active` sin que se le asigne el plan en roles: la marca paga y no habilita nada).
    it('el primer cobro exitoso sobre una fila `pending` la activa y le asigna el plan en roles', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PENDING }))
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cobro('SUCCEEDED'))

      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-03-01T00:00:00Z'),
      )
      expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
    })

    it('empuja a roles ANTES de abrir la transacción, para no sostener el lock', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cobro('SUCCEEDED'))

      expect(roles.assignPlanToBrand.mock.invocationCallOrder[0]).toBeLessThan(
        dataSource.transaction.mock.invocationCallOrder[0],
      )
    })
  })

  // ------------------------------------------------------ (3) idempotencia
  // ---------------------------------------- (7) la confirmación es la que otorga
  //
  // `TRIALING` y `ACTIVE` son los dos estados con los que ConfioPagos reporta una
  // suscripción YA ACEPTADA. Desde la regla «no se otorga el plan sin suscripción
  // de verdad» (Manuel, 2026-09-02) son el único momento en que una prueba
  // consigue acceso: el alta dejó de repartirlo.
  describe('la confirmación de ConfioPagos otorga el plan', () => {
    /** Alta de PRUEBA esperando la aceptación: sin acceso todavía. */
    function pendienteDeAceptacion(over: Record<string, any> = {}) {
      return suscripcion({
        status: SubscriptionStatus.PENDING,
        trialStart: new Date('2026-01-14T10:00:00Z'),
        trialEnd: new Date('2026-01-29T10:00:00Z'),
        ...over,
      })
    }

    it('TRIALING asigna el plan con el fin de período del proveedor', async () => {
      conSuscripcion(pendienteDeAceptacion())
      // A propósito distinto del `trialEnd` de la fila (01-29) y del avance
      // mensual (03-01): si el handler usara cualquiera de los dos, esto se pone rojo.
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
        currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
        nextBillingTime: new Date('2026-02-02T10:00:00Z'),
      })

      await despachar(cambioDeEstado('TRIALING'))

      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-02-02T10:00:00Z'),
      )
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.TRIAL)
      // Lo prometido a roles y lo persistido son el MISMO valor: el período se
      // resuelve una sola vez, en la fase de decisión.
      expect(suscripcionGuardada().currentPeriodEnd).toEqual(
        roles.assignPlanToBrand.mock.calls[0][2],
      )
    })

    it('ACTIVE también otorga (antes era un hueco deliberado del handler)', async () => {
      conSuscripcion(pendienteDeAceptacion())
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
        currentPeriodEnd: new Date('2026-02-14T10:00:00Z'),
        nextBillingTime: new Date('2026-02-14T10:00:00Z'),
      })

      await despachar(cambioDeEstado('ACTIVE'))

      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-02-14T10:00:00Z'),
      )
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
    })

    it('TRIALING sin período del proveedor respeta el `trialEnd`, NO el ciclo mensual', async () => {
      conSuscripcion(pendienteDeAceptacion())
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cambioDeEstado('TRIALING'))

      // 15 días de prueba, no 30 de un ciclo pago: el respaldo mensual regalaría
      // el doble de acceso del que se contrató.
      const finDePrueba = new Date('2026-01-29T10:00:00Z')
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG, finDePrueba)
      expect(suscripcionGuardada().currentPeriodEnd).toEqual(finDePrueba)
    })

    it('ACTIVE sin período del proveedor sí cae al ciclo mensual', async () => {
      conSuscripcion(pendienteDeAceptacion())
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cambioDeEstado('ACTIVE'))

      // La fila trae `currentPeriodEnd` 2026-02-01, todavía vigente al reloj fijo.
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-03-01T00:00:00Z'),
      )
    })

    it.each([
      ['sin trialEnd', { trialEnd: null }],
      ['con el trialEnd ya vencido', { trialEnd: new Date('2026-01-01T00:00:00Z') }],
      ['con un trialEnd inválido', { trialEnd: new Date('no-es-fecha') }],
    ])(
      'TRIALING %s aplica el estado pero NO otorga: no se inventa un vencimiento',
      async (_caso, over) => {
        conSuscripcion(pendienteDeAceptacion(over))
        confio.getSubscription.mockRejectedValue(new Error('502 confio'))

        await despachar(cambioDeEstado('TRIALING'))

        expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
        expect(suscripcionGuardada().status).toBe(SubscriptionStatus.TRIAL)
      },
    )

    it.each([SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED])(
      'una confirmación tardía sobre una fila %s no compra el plan de nuevo',
      async (status) => {
        conSuscripcion(pendienteDeAceptacion({ status }))
        confio.getSubscription.mockResolvedValue({
          currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
          currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
          nextBillingTime: new Date('2026-02-02T10:00:00Z'),
        })

        await despachar(cambioDeEstado('TRIALING'))

        expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      },
    )

    it('una confirmación sobre una baja pendiente tampoco otorga', async () => {
      // Estado vivo, pero con baja NUESTRA ya sellada y acceso todavía corriendo:
      // del lado de ellos esa suscripción ya está cancelada y no vuelve a cobrar.
      conSuscripcion(
        pendienteDeAceptacion({
          status: SubscriptionStatus.TRIAL,
          cancelledAt: new Date('2026-01-10T00:00:00Z'),
          accessEndsAt: new Date('2026-01-29T10:00:00Z'),
        }),
      )
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
        currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
        nextBillingTime: new Date('2026-02-02T10:00:00Z'),
      })

      await despachar(cambioDeEstado('TRIALING'))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
    })

    it('una suscripción sin planSlug no otorga con un slug vacío', async () => {
      conSuscripcion(pendienteDeAceptacion({ planSlug: '' }))
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
        currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
        nextBillingTime: new Date('2026-02-02T10:00:00Z'),
      })

      await despachar(cambioDeEstado('TRIALING'))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
    })

    it('la reentrega de la MISMA confirmación no vuelve a otorgar', async () => {
      conSuscripcion(pendienteDeAceptacion())
      confio.getSubscription.mockResolvedValue({
        currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
        currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
        nextBillingTime: new Date('2026-02-02T10:00:00Z'),
      })
      // El marcador de ESE evento ya está escrito: corta antes de roles y antes
      // de preguntarle el período al proveedor.
      eventRepo.createQueryBuilder.mockReturnValue(qb({ id: 'se-1' }))

      await despachar(cambioDeEstado('TRIALING'), 'ev-repetido')

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(confio.getSubscription).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('deja la traza del otorgamiento en la fila de historial', async () => {
      conSuscripcion(pendienteDeAceptacion())
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cambioDeEstado('TRIALING'))

      expect(historial()[0].metadata.roles).toEqual({
        accion: 'reponer',
        brandId: BRAND_ID,
        planSlug: PLAN_SLUG,
        expiresAt: '2026-01-29T10:00:00.000Z',
      })
    })
  })

  // ------------------------------- (8) confirmación ACTIVA: preguntar, no esperar
  //
  // La vía que hace que el estado no dependa del webhook (Manuel, 2026-09-02, tras un
  // pago real que ConfioPagos registró y del que nunca llegó callback).
  describe('confirmarContraElProveedor', () => {
    const REMOTA = {
      status: 'TRIALING',
      currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
      currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
      nextBillingTime: new Date('2026-02-02T10:00:00Z'),
    }

    function esperando(over: Record<string, any> = {}) {
      return conSuscripcion(
        suscripcion({
          status: SubscriptionStatus.PENDING,
          currentPeriodEnd: new Date('2026-01-29T10:00:00Z'),
          trialStart: new Date('2026-01-14T10:00:00Z'),
          trialEnd: new Date('2026-01-29T10:00:00Z'),
          ...over,
        }),
      )
    }

    it('otorga el plan con el período del proveedor, igual que el webhook', async () => {
      const sub = esperando()
      confio.getSubscription.mockResolvedValue(REMOTA)

      const res = await service.confirmarContraElProveedor(sub)

      expect(res.resultado).toBe('otorgada')
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-02-02T10:00:00Z'),
      )
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.TRIAL)
      expect(suscripcionGuardada().currentPeriodEnd).toEqual(
        roles.assignPlanToBrand.mock.calls[0][2],
      )
    })

    it('le pide el estado al proveedor UNA sola vez', async () => {
      // Mutación: no pasarle la lectura al planificador — cada sondeo del front le
      // pediría dos veces la misma suscripción a ConfioPagos.
      confio.getSubscription.mockResolvedValue(REMOTA)

      await service.confirmarContraElProveedor(esperando())

      expect(confio.getSubscription).toHaveBeenCalledTimes(1)
    })

    it('la traza dice que el hecho salió de preguntar, no de que nos avisaran', async () => {
      confio.getSubscription.mockResolvedValue(REMOTA)

      await service.confirmarContraElProveedor(esperando())

      expect(historial()[0].metadata.event).toBe('subscription.confirmacionActiva')
    })

    it('todavía sin aceptar NO es un error ni toca nada', async () => {
      // Mutación: tratar cualquier estado remoto como otorgable — se le daría el plan
      // a quien no completó el pago, que es lo contrario de toda esta épica.
      confio.getSubscription.mockResolvedValue({ ...REMOTA, status: 'PENDING_ACCEPTANCE' })

      const res = await service.confirmarContraElProveedor(esperando())

      expect(res.resultado).toBe('sin_confirmar')
      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('un fallo del canal NO se cuenta como «no aceptó»', async () => {
      // Mutación: colapsar el catch en `sin_confirmar` — una caída de ConfioPagos se
      // le contaría al usuario como que no pagó.
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      const res = await service.confirmarContraElProveedor(esperando())

      expect(res.resultado).toBe('proveedor_no_disponible')
      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('sin suscripción en el proveedor no se inventa una consulta', async () => {
      const res = await service.confirmarContraElProveedor(
        conSuscripcion(
          suscripcion({ status: SubscriptionStatus.PENDING, providerSubscriptionId: '', metadata: null }),
        ),
      )

      expect(res.resultado).toBe('sin_suscripcion_en_el_proveedor')
      expect(confio.getSubscription).not.toHaveBeenCalled()
    })

    it('las guardas del webhook siguen valiendo: sobre una fila terminal no otorga', async () => {
      confio.getSubscription.mockResolvedValue(REMOTA)

      const res = await service.confirmarContraElProveedor(
        esperando({ status: SubscriptionStatus.CANCELLED }),
      )

      expect(res.resultado).toBe('sin_efecto')
      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
    })
  })

  // El mismo hecho contado por dos vías distintas no puede aplicarse dos veces: las
  // claves de idempotencia NO coinciden (la del webhook la acuña Confío con su
  // `updateTime`, que su API de consulta no devuelve), así que lo que lo impide es la
  // guarda de estado + período.
  describe('el mismo hecho por dos vías no produce dos efectos', () => {
    const REMOTA = {
      status: 'TRIALING',
      currentPeriodStart: new Date('2026-01-14T10:00:00Z'),
      currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
      nextBillingTime: new Date('2026-02-02T10:00:00Z'),
    }

    it('confirmar dos veces seguidas otorga una sola vez', async () => {
      const sub = conSuscripcion(
        suscripcion({ status: SubscriptionStatus.PENDING, currentPeriodEnd: null }),
      )
      confio.getSubscription.mockResolvedValue(REMOTA)

      await service.confirmarContraElProveedor(sub)
      // La segunda corre sobre la fila YA aplicada, como la relee el handler.
      sub.status = SubscriptionStatus.TRIAL
      sub.currentPeriodEnd = new Date('2026-02-02T10:00:00Z')
      const segunda = await service.confirmarContraElProveedor(sub)

      expect(segunda.resultado).toBe('sin_efecto')
      expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
    })

    it('el webhook que llega DESPUÉS de haber confirmado no escribe un segundo evento', async () => {
      // Mutación: quitar la guarda de «mismo estado y mismo período» — el historial
      // acumula dos filas del mismo hecho y roles recibe un movimiento de más.
      conSuscripcion(
        suscripcion({
          status: SubscriptionStatus.TRIAL,
          currentPeriodEnd: new Date('2026-02-02T10:00:00Z'),
        }),
      )
      confio.getSubscription.mockResolvedValue(REMOTA)

      await despachar(cambioDeEstado('TRIALING'))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('una RENOVACIÓN sí pasa: mismo estado, período nuevo', async () => {
      // Mutación: comparar sólo el estado — el cobro del ciclo siguiente dejaría de
      // extender el acceso y la marca perdería el plan al vencer el período viejo.
      conSuscripcion(
        suscripcion({
          status: SubscriptionStatus.TRIAL,
          currentPeriodEnd: new Date('2026-01-20T10:00:00Z'),
        }),
      )
      confio.getSubscription.mockResolvedValue(REMOTA)

      await despachar(cambioDeEstado('TRIALING'))

      expect(roles.assignPlanToBrand).toHaveBeenCalledWith(
        BRAND_ID,
        PLAN_SLUG,
        new Date('2026-02-02T10:00:00Z'),
      )
    })
  })

  describe('una notificación reentregada no repite la escritura en roles', () => {
    it('el marcador previo corta antes de roles y antes del proveedor', async () => {
      conSuscripcion(suscripcion())
      eventRepo.createQueryBuilder.mockReturnValue(qb({ id: 'se-previo' }))

      await despachar(cobro('SUCCEEDED'))

      expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(confio.getSubscription).not.toHaveBeenCalled()
      expect(manager.save).not.toHaveBeenCalled()
    })

    it('el marcador que sólo aparece bajo el lock no deja escribir dos veces', async () => {
      conSuscripcion(suscripcion())
      manager.createQueryBuilder.mockReturnValue(qb({ id: 'se-previo' }))

      await despachar(cobro('FAILED'))

      expect(manager.save).not.toHaveBeenCalled()
      // Residual ACEPTADO: dos entregas concurrentes del MISMO evento pueden
      // empujar el retiro a roles dos veces. Es idempotente del otro lado
      // (DELETE del vínculo, upsert en la reposición) y la alternativa sería
      // sostener la llamada HTTP dentro del lock.
      expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------- (4) roles caído
  describe('un fallo del canal de roles no es un impago', () => {
    it.each([
      ['el retiro', cobro('FAILED'), 'removePlanFromBrand'],
      ['la reposición', cobro('SUCCEEDED'), 'assignPlanToBrand'],
    ] as Array<[string, any, 'removePlanFromBrand' | 'assignPlanToBrand']>)(
      '%s que roles rechaza deja CERO escrituras locales y lanza',
      async (_nombre, payload, metodo) => {
        conSuscripcion(suscripcion())
        confio.getSubscription.mockRejectedValue(new Error('502 confio'))
        roles[metodo].mockResolvedValue(false)

        await expect(service.handle(evento(payload))).rejects.toThrow(/roles/i)

        // Ni el estado ni el historial: el acceso no cambió y no se degradó.
        expect(dataSource.transaction).not.toHaveBeenCalled()
        expect(manager.save).not.toHaveBeenCalled()
      },
    )
  })

  // ------------------------------------------------- (5) traza del movimiento
  /**
   * `trazabilidad-de-movimientos` (épica 002, criterio 2): de cada movimiento
   * que reporta ConfioPagos se reconstruye el hecho completo —marca, usuario,
   * plan, monto, moneda, referencia del proveedor y resultado— leyendo SÓLO la
   * fila de `subscription_events`, sin volver a preguntarle al proveedor.
   *
   * Los cinco casos tienen roles DISTINTOS y declarados: 1 pinnea la FORMA
   * completa del `metadata`, 2 y 3 verifican campo por campo los dos resultados
   * restantes, 4 defiende la totalidad del armado y 5 es guarda de regresión
   * sobre el acoplamiento traza↔idempotencia.
   */
  describe('la traza del movimiento reconstruye el hecho sin el proveedor', () => {
    it('el cobro exitoso deja la fila completa (forma CERRADA del metadata)', async () => {
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      // Se rechaza a propósito: la traza no depende del período remoto.
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))

      await despachar(cobro('SUCCEEDED'))

      expect(historial()).toHaveLength(1)
      const fila = historial()[0]
      expect(fila.subscriptionId).toBe(SUB_ID)
      expect(fila.eventType).toBe('payment_succeeded')
      expect(fila.fromStatus).toBe(SubscriptionStatus.PAST_DUE)
      expect(fila.toStatus).toBe(SubscriptionStatus.ACTIVE)
      expect(fila.triggeredBy).toBe('confio-webhook')

      // `toEqual` ESTRICTO y no `toMatchObject`, a propósito: esta fila entera
      // sale por `GET /subscription/history`
      // (`subscription.service.ts:606-620` hace `find()` sin `select`), y ese
      // endpoint tiene autenticación SOLA —ningún `@RequirePermission` y ninguna
      // validación de que el `brandId` pedido sea del que llama—. O sea que todo
      // lo que caiga en `metadata` queda legible por cualquier usuario
      // autenticado. El `toEqual` es el candado: agregar un campo sin decidirlo
      // —PII del comprador (`ConfioBuyer` trae email y teléfono), tokens,
      // resource names de más— pone el build en rojo acá.
      // rojo si: se borra `brandId` del metadata armado (o se agrega CUALQUIER
      // clave nueva).
      expect(fila.metadata).toEqual({
        event: 'subscription.billingStatusChanged',
        providerEventId: 'ev-1',
        brandId: BRAND_ID,
        userId: 'user-1',
        planSlug: PLAN_SLUG,
        amountCents: 1990000,
        currencyCode: 'COP',
        cycleNumber: 3,
        providerRef: { name: SUB_NAME, payment: 'organizations/o/stores/s/payments/p3' },
        roles: {
          accion: 'reponer',
          brandId: BRAND_ID,
          planSlug: PLAN_SLUG,
          expiresAt: '2026-03-01T00:00:00.000Z',
        },
      })
    })

    // rojo si: se deja de copiar `data.reason` a la COLUMNA `reason` (la
    // aceptación pide la columna, no el metadata), o falta cualquiera de los
    // campos afirmados uno por uno acá abajo.
    it('el cobro fallido deja el motivo en la columna `reason` y la referencia sin pago', async () => {
      conSuscripcion(suscripcion())

      await despachar(cobro('FAILED'))

      expect(historial()).toHaveLength(1)
      const fila = historial()[0]
      expect(fila.eventType).toBe('payment_failed')
      expect(fila.fromStatus).toBe(SubscriptionStatus.ACTIVE)
      expect(fila.toStatus).toBe(SubscriptionStatus.PAST_DUE)
      expect(fila.triggeredBy).toBe('confio-webhook')
      // La COLUMNA, no el metadata.
      expect(fila.reason).toBe('INSUFFICIENT_FUNDS')

      expect(fila.metadata.event).toBe('subscription.billingStatusChanged')
      expect(fila.metadata.providerEventId).toBe('ev-1')
      expect(fila.metadata.brandId).toBe(BRAND_ID)
      expect(fila.metadata.userId).toBe('user-1')
      expect(fila.metadata.planSlug).toBe(PLAN_SLUG)
      expect(fila.metadata.amountCents).toBe(1990000)
      expect(fila.metadata.currencyCode).toBe('COP')
      expect(fila.metadata.cycleNumber).toBe(3)
      // El fallo no trae `payment`: la referencia lleva el motivo en su lugar.
      expect(fila.metadata.providerRef).toEqual({ name: SUB_NAME, reason: 'INSUFFICIENT_FUNDS' })
      expect(fila.metadata.providerRef).not.toHaveProperty('payment')
    })

    // rojo si: se remapea `CANCELED` a otro `SubscriptionEventType`, o se deja
    // de leer `planSlug` de la fila bloqueada.
    it('la cancelación deja la traza sin monto ni ciclo, que su payload no trae', async () => {
      conSuscripcion(suscripcion())

      await despachar(cambioDeEstado('CANCELED'))

      expect(historial()).toHaveLength(1)
      const fila = historial()[0]
      expect(fila.eventType).toBe('cancelled')
      expect(fila.toStatus).toBe(SubscriptionStatus.CANCELLED)
      expect(fila.triggeredBy).toBe('confio-webhook')

      expect(fila.metadata.event).toBe('subscription.subscriptionStatusChanged')
      expect(fila.metadata.providerEventId).toBe('ev-1')
      expect(fila.metadata.brandId).toBe(BRAND_ID)
      expect(fila.metadata.userId).toBe('user-1')
      expect(fila.metadata.planSlug).toBe(PLAN_SLUG)
      expect(fila.metadata.providerRef).toEqual({ name: SUB_NAME })
      expect(fila.metadata.providerRef).not.toHaveProperty('payment')
      // Ausencia y NUNCA `toBeNull()`: en el jsonb real una clave `undefined` se
      // serializa como AUSENTE, así que un `toBeNull()` pasaría en unit y
      // mentiría sobre la fila. La aceptación admite «null/omitidos».
      expect(fila.metadata.amountCents).toBeUndefined()
      expect(fila.metadata.currencyCode).toBeUndefined()
      expect(fila.metadata.cycleNumber).toBeUndefined()
    })

    // rojo si: el armado lee un opcional sin guarda (p. ej. `data.reason.trim()`).
    // Eso tira `TypeError` DENTRO de la transacción y se la lleva puesta entera:
    // no queda fila y el estado no cambia, con lo cual caen las dos aserciones de
    // efecto de abajo. Es lo único que sostiene la totalidad del armado: el
    // tsconfig tiene `strictNullChecks: false` y el compilador no la ve.
    it('un payload mutilado escribe la fila igual y NO impide el efecto', async () => {
      // Arranca en `past_due` a propósito: la fábrica nace `ACTIVE`, así que
      // afirmar `active` sobre ella sería vacuo —pasaría sin que nada cambiara—.
      conSuscripcion(suscripcion({ status: SubscriptionStatus.PAST_DUE }))
      confio.getSubscription.mockRejectedValue(new Error('502 confio'))
      const payload = cobro('SUCCEEDED')
      // Borrado REAL de las claves, no `undefined` por `over`: un `undefined`
      // explícito oculta el caso de la clave que nunca vino.
      delete payload.data.amountCents
      delete payload.data.cycleNumber

      await despachar(payload)

      expect(historial()).toHaveLength(1)
      const fila = historial()[0]
      expect(fila.metadata.brandId).toBe(BRAND_ID)
      expect(fila.metadata.userId).toBe('user-1')
      expect(fila.metadata.planSlug).toBe(PLAN_SLUG)
      expect(fila.metadata.event).toBe('subscription.billingStatusChanged')
      expect(fila.metadata.providerEventId).toBe('ev-1')
      expect(fila.metadata.amountCents).toBeUndefined()
      expect(fila.metadata.cycleNumber).toBeUndefined()
      // El efecto de negocio SE APLICÓ pese al payload mutilado. Las dos
      // aserciones sólo pasan si hubo transición real.
      expect(fila.fromStatus).toBe(SubscriptionStatus.PAST_DUE)
      expect(suscripcionGuardada().status).toBe(SubscriptionStatus.ACTIVE)
    })

    /**
     * TEST DE GUARDA, no un rojo prometido: el handler YA escribe
     * `providerEventId` en el `metadata`, así que con un doble realista de
     * `getOne` este caso NACE VERDE. Su valor es fijar el acoplamiento
     * traza↔idempotencia para que la refactorización no lo rompa.
     *
     * Cómo comprobar que muerde (procedimiento, ejercido y revertido al
     * construir esta tarea): quitar `providerEventId` del metadata armado en
     * `confio-traza.util.ts` ⇒ el marcador deja de encontrarse y quedan DOS
     * filas. La deduplicación es `metadata ->> 'providerEventId'`, extracción de
     * TEXTO en la RAÍZ del jsonb: anidar o renombrar esa clave regala un período.
     */
    it('la reentrega del mismo providerEventId sigue dejando UNA sola fila', async () => {
      conSuscripcion(suscripcion())
      // El helper `qb()` compartido conserva su `getOne: null` para el resto del
      // spec; acá y sólo acá se sobreescriben los DOS builders, porque el
      // pre-chequeo usa el repo y la relectura bajo lock usa el manager.
      const buscador = () => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () =>
          historial().find((f: any) => f?.metadata?.providerEventId === 'ev-1') || null,
        ),
      })
      eventRepo.createQueryBuilder.mockImplementation(buscador)
      manager.createQueryBuilder.mockImplementation(buscador)

      await despachar(cobro('FAILED'))
      await despachar(cobro('FAILED'))

      expect(historial()).toHaveLength(1)
      expect(historial()[0].metadata.providerEventId).toBe('ev-1')
    })
  })
})

// ============================================================================
// El webhook queda marcado para reintento: la única consecuencia del fallo de
// canal que vive FUERA del handler (`WebhookService.processEvent`).
// ============================================================================

describe('WebhookService — roles caído marca el webhook para reintento', () => {
  let service: WebhookService
  let writeRepo: any
  let queue: { add: jest.Mock }

  beforeEach(async () => {
    writeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d) => d),
      save: jest.fn((d) => Promise.resolve(d)),
    }
    queue = { add: jest.fn().mockResolvedValue(undefined) }

    const manager = {
      findOne: jest.fn().mockResolvedValue(suscripcion()),
      save: jest.fn((...args: any[]) => Promise.resolve(args[args.length - 1])),
      createQueryBuilder: jest.fn(() => qb(null)),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        ConfioSubscriptionWebhookService,
        { provide: getRepositoryToken(WebhookEvent, 'DBWrite'), useValue: writeRepo },
        { provide: getRepositoryToken(WebhookEvent, 'DBRead'), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(Subscription, 'DBWrite'),
          useValue: { findOne: jest.fn().mockResolvedValue(suscripcion()) },
        },
        {
          provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'),
          useValue: { createQueryBuilder: jest.fn(() => qb(null)) },
        },
        { provide: getDataSourceToken('DBWrite'), useValue: { transaction: jest.fn((cb: any) => cb(manager)) } },
        { provide: ConfioProvider, useValue: { getSubscription: jest.fn() } },
        {
          provide: ClientRolesService,
          useValue: {
            // Canal caído: `callRolesApi` colapsa 4xx, 5xx y timeout en `false`.
            removePlanFromBrand: jest.fn().mockResolvedValue(false),
            assignPlanToBrand: jest.fn().mockResolvedValue(false),
            renewPlanForBrand: jest.fn().mockResolvedValue(false),
          },
        },
        { provide: getQueueToken('webhook-retry'), useValue: queue },
      ],
    }).compile()

    service = module.get<WebhookService>(WebhookService)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it('marca el evento fallido y lo encola con el primer backoff', async () => {
    const e = evento(cobro('FAILED'))

    await expect(service['processEvent'](e)).rejects.toThrow(/roles/i)

    expect(e.status).toBe(WebhookStatus.FAILED)
    expect(e.retryCount).toBe(1)
    expect(e.error).toMatch(/roles/i)
    expect(queue.add).toHaveBeenCalledWith(
      'retry',
      { eventId: 'we-1' },
      expect.objectContaining({ delay: 60000 }),
    )
  })
})
