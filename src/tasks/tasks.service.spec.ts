import { In } from 'typeorm'

import { TasksService } from './tasks.service'
import { SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'

const mockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  save: jest.fn((d) => Promise.resolve(d)),
  create: jest.fn((d) => d),
  update: jest.fn().mockResolvedValue({ affected: 0 }),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
})

describe('TasksService — processTrialConversions', () => {
  let service: TasksService
  let subscriptionRepo: ReturnType<typeof mockRepo>
  let subscriptionEventRepo: ReturnType<typeof mockRepo>
  let clientRoles: any
  let walletService: any
  let eventBus: any
  let checkoutService: any
  let paymentRepo: ReturnType<typeof mockRepo>
  let providerFactory: any

  beforeEach(() => {
    subscriptionRepo = mockRepo()
    // Los dos disparadores de cron vencen la fila con un compare-and-set
    // (`update` con el estado esperado en el criterio), no con `save`: `affected`
    // es lo que distingue «la vencí yo» de «me la ganó una pasada solapada».
    subscriptionRepo.update.mockResolvedValue({ affected: 1 })
    subscriptionEventRepo = mockRepo()
    paymentRepo = mockRepo()
    providerFactory = { getProvider: jest.fn() }
    clientRoles = {
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      renewPlanForBrand: jest.fn().mockResolvedValue(true),
      getPlanPrice: jest.fn().mockResolvedValue(0),
    }
    walletService = { debit: jest.fn().mockResolvedValue(true), credit: jest.fn() }
    eventBus = {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
      publishSubscriptionRenewed: jest.fn(),
      notifyPaymentFailed: jest.fn().mockResolvedValue(null),
      publishNotification: jest.fn().mockResolvedValue(null),
    }
    checkoutService = {
      processCheckout: jest.fn().mockResolvedValue({ paymentId: 'pay-1', status: 'pending', checkoutUrl: 'https://pay.confio/abc' }),
      completeExternalPayment: jest.fn().mockResolvedValue(undefined),
    }

    service = new TasksService(
      mockRepo() as any, // walletReadRepo
      mockRepo() as any, // snapshotRepo
      mockRepo() as any, // transactionReadRepo
      paymentRepo as any,
      subscriptionRepo as any,
      subscriptionEventRepo as any,
      mockRepo() as any, // webhookEventRepo
      {} as any, // dataSource
      walletService as any,
      {} as any, // auditService
      providerFactory as any,
      eventBus as any,
      clientRoles as any,
      checkoutService as any,
    )
  })

  it('degrada a free un trial vencido sin método de pago', async () => {
    subscriptionRepo.find.mockResolvedValue([
      { id: 's1', brandId: 'b1', planSlug: 'pro', provider: 'wallet', walletId: null, status: SubscriptionStatus.TRIAL },
    ])

    await service.processTrialConversions()

    // El estado terminal se escribe con un compare-and-set contra `trial`.
    expect(subscriptionRepo.update).toHaveBeenCalledWith(
      { id: 's1', status: SubscriptionStatus.TRIAL },
      { status: SubscriptionStatus.EXPIRED, autoRenew: false },
    )
    expect(subscriptionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: SubscriptionEventType.TRIAL_ENDED }),
    )
    expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
    expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
    // `free` SIN `expiresAt`: un plan que no se cobra no vence. Con un tercer
    // argumento el cron de roles lo barrería y la marca quedaría sin plan.
    expect(clientRoles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
    expect(walletService.debit).not.toHaveBeenCalled()
  })

  // Aceptación 5: un canal caído no es un hecho sobre la suscripción. Si roles no
  // acepta el retiro, la fila NO se marca degradada y el cron horario la retoma.
  it('un trial sin método de pago que roles rechaza no queda marcado como degradado', async () => {
    clientRoles.removePlanFromBrand.mockResolvedValue(false)
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        provider: 'wallet',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
      },
    ])

    await service.processTrialConversions()

    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    expect(subscriptionRepo.save).not.toHaveBeenCalled()
    expect(subscriptionRepo.update).not.toHaveBeenCalled()
    expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
    expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
  })

  // Una pasada solapada ya terminó el trial: el compare-and-set no afecta filas y
  // esta pasada no escribe una SEGUNDA fila de historial (aceptación 4).
  it('un trial que otra pasada ya terminó no escribe un segundo evento', async () => {
    subscriptionRepo.update.mockResolvedValue({ affected: 0 })
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        provider: 'wallet',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
      },
    ])

    await service.processTrialConversions()

    expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
    expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
  })

  it('cobra de wallet y activa un trial vencido con método de pago', async () => {
    clientRoles.getPlanPrice.mockResolvedValue(50000)
    subscriptionRepo.find.mockResolvedValue([
      { id: 's1', brandId: 'b1', planSlug: 'pro', provider: 'wallet', walletId: 'w1', status: SubscriptionStatus.TRIAL, retryCount: 0 },
    ])

    await service.processTrialConversions()

    // 3 argumentos exactos: el cron NO pasa `expectedCurrency`. La aserción se rompe el
    // día que alguien cablee la guarda de moneda dentro de `renewFromWallet`.
    expect(walletService.debit).toHaveBeenCalledWith('w1', 50000, expect.any(Object))
    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.ACTIVE }),
    )
    expect(clientRoles.renewPlanForBrand).toHaveBeenCalled()
    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'free')
  })

  it('marca past_due si el cobro de wallet falla por saldo insuficiente', async () => {
    clientRoles.getPlanPrice.mockResolvedValue(50000)
    walletService.debit.mockRejectedValue(new Error('saldo insuficiente'))
    subscriptionRepo.find.mockResolvedValue([
      { id: 's1', brandId: 'b1', planSlug: 'pro', provider: 'wallet', walletId: 'w1', status: SubscriptionStatus.TRIAL, retryCount: 0 },
    ])

    await service.processTrialConversions()

    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.PAST_DUE }),
    )
    expect(eventBus.notifyPaymentFailed).toHaveBeenCalled()
  })

  it('emite link de cobro Confío para un trial externo vencido (no degrada)', async () => {
    subscriptionRepo.find.mockResolvedValue([
      // `initialPaymentLinkIssuedAt: null` explícito: es el discriminante del caso de al lado.
      {
        id: 's1',
        brandId: 'b1',
        userId: 'u1',
        planSlug: 'pro',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: null,
      },
    ])

    await service.processTrialConversions()

    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'confio',
        purpose: 'plan_purchase',
        planSlug: 'pro',
        brandId: 'b1',
        renewal: true,
      }),
    )
    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.PAST_DUE }),
    )
    // Notifica el link de pago, NO degrada a free.
    expect(eventBus.publishNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment_link' }),
    )
    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'free')
  })

  it('NO emite un segundo link si el alta ya emitió el link inicial', async () => {
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b1',
        userId: 'u1',
        planSlug: 'dropi-roax',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: new Date('2026-08-10T00:00:00Z'),
      },
    ])

    await service.processTrialConversions()

    // Ni segundo link ni notificación ni cambio de estado: la fila queda intacta.
    expect(checkoutService.processCheckout).not.toHaveBeenCalled()
    expect(subscriptionRepo.save).not.toHaveBeenCalled()
    expect(eventBus.publishNotification).not.toHaveBeenCalled()
    // Tampoco degrada: la degradación por `trialEnd` es de otra tarea.
    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'free')
  })

  it('lote mixto: sólo la fila sin marcar recibe link', async () => {
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b-marcada',
        userId: 'u1',
        planSlug: 'dropi-roax',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: new Date('2026-08-10T00:00:00Z'),
      },
      {
        id: 's2',
        brandId: 'b-sin-marcar',
        userId: 'u2',
        planSlug: 'dropi-roax',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: null,
      },
    ])

    await service.processTrialConversions()

    expect(checkoutService.processCheckout).toHaveBeenCalledTimes(1)
    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ brandId: 'b-sin-marcar' }),
    )
  })

  /**
   * ⚠️ DINERO. Desde `cancelar-marca-baja-al-fin-de-periodo` la baja YA NO mueve la
   * fila a `cancelled`: apaga `autoRenew` y la deja en su estado vigente. Un trial
   * dado de baja se queda entonces en `trial`, y sin este filtro volvería a caer en
   * esta consulta: si es `provider = 'wallet'` con `walletId`, `renewFromWallet`
   * DEBITARÍA la wallet de alguien que ya se dio de baja. El filtro es el candado.
   */
  it('no convierte un trial con la renovación apagada: la consulta filtra por autoRenew', async () => {
    await service.processTrialConversions()

    // Se afirma el `where` ENTERO, no un `objectContaining`: lo que hay que fijar es
    // que la consulta no se afloje, y un criterio de más (o el `autoRenew` de menos)
    // tiene que ponerlo rojo. Verificarlo devolviendo filas desde un repo falso que
    // implemente el mismo filtro no probaría nada: probaría el doble.
    const { where } = subscriptionRepo.find.mock.calls[0][0]
    expect(Object.keys(where).sort()).toEqual(['autoRenew', 'nextBillingDate', 'status'])
    expect(where.status).toBe(SubscriptionStatus.TRIAL)
    expect(where.autoRenew).toBe(true)
  })

  /**
   * `degradacion-a-free-y-baja-en-roles` (épica 002, criterio 3), tercer
   * disparador: la suscripción vence con los reintentos agotados.
   *
   * Rojo si: se quita `assignPlanToBrand(brandId, FREE_PLAN_SLUG)` de
   * `downgradeBrandToFree` (la mutación de control declarada por la tarea).
   */
  describe('expireSubscriptions', () => {
    const enMora = (over: Record<string, any> = {}) => ({
      id: 's1',
      brandId: 'b1',
      planSlug: 'pro',
      status: SubscriptionStatus.PAST_DUE,
      retryCount: 3,
      autoRenew: true,
      ...over,
    })

    it('con los reintentos agotados saca el plan pago y deja free', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora()])

      await service.expireSubscriptions()

      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
      expect(clientRoles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
      expect(clientRoles.removePlanFromBrand.mock.invocationCallOrder[0]).toBeLessThan(
        clientRoles.assignPlanToBrand.mock.invocationCallOrder[0],
      )
      // ⚠️ DINERO: `autoRenew` encendido deja la fila elegible para los crons de
      // renovación, que emitirían un cobro sobre una suscripción ya vencida.
      // Compare-and-set contra `past_due`: dos pasadas solapadas no la vencen dos
      // veces (los `@Cron` de Nest no se excluyen entre sí).
      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
      )
      expect(subscriptionEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: SubscriptionEventType.EXPIRED,
          fromStatus: SubscriptionStatus.PAST_DUE,
          toStatus: SubscriptionStatus.EXPIRED,
          triggeredBy: 'system',
          reason: expect.stringMatching(/reintentos/i),
        }),
      )
      expect(eventBus.publishSubscriptionExpired).toHaveBeenCalled()
    })

    it('la mora con reintentos disponibles no degrada ni escribe', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora({ retryCount: 1 })])

      await service.expireSubscriptions()

      expect(clientRoles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(subscriptionRepo.update).not.toHaveBeenCalled()
    })

    it('si roles rechaza el retiro no vence la fila y la pasada siguiente reintenta', async () => {
      clientRoles.removePlanFromBrand.mockResolvedValue(false)
      const fila = enMora()
      subscriptionRepo.find.mockResolvedValue([fila])

      await service.expireSubscriptions()

      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
      // La fila NO se vence…
      expect(subscriptionRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SubscriptionStatus.EXPIRED }),
      )
      // …pero ⚠️ DINERO: en `past_due`, con `autoRenew` encendido y
      // `nextBillingDate` vencido, seguiría siendo elegible para
      // `processSubscriptionRenewals` y `retryFailedPayments`, que DEBITAN la
      // wallet. Mientras dure la caída de roles se apaga el riel de cobro, que no
      // toca el acceso, y la degradación se reintenta igual.
      expect(subscriptionRepo.update).toHaveBeenCalledWith({ id: 's1' }, { autoRenew: false })

      // La fila sigue en `past_due` con los reintentos agotados: el cron la vuelve
      // a tomar y, con roles de pie, la degrada. Idempotencia por reintento.
      clientRoles.removePlanFromBrand.mockResolvedValue(true)
      await service.expireSubscriptions()

      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
      )
    })

    // Aceptación 4, «segunda pasada del cron»: la ventana entre el `find` y la
    // escritura es ancha (la degradación es HTTP con 10 s de timeout) y los
    // `@Cron` de Nest no se excluyen. El compare-and-set no afecta filas y esta
    // pasada no escribe una segunda fila de historial.
    it('una pasada solapada que ya venció la fila no escribe un segundo evento', async () => {
      subscriptionRepo.update.mockResolvedValue({ affected: 0 })
      subscriptionRepo.find.mockResolvedValue([enMora()])

      await service.expireSubscriptions()

      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
    })


    // La invariante de `accessEndsAt` es «no nula ⇔ baja PENDIENTE»: una fila
    // terminal no tiene baja pendiente. Este cron se queda además con las filas de
    // la intersección (baja sellada + mora agotada), que si no dejarían colgada la
    // fecha de corte de una baja que ya se consumó.
    it('la fila vencida no conserva fecha de corte', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora({ accessEndsAt: new Date('2026-08-27T10:00:00.000Z') })])

      await service.expireSubscriptions()

      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
      )
    })

    // Un segmento vacío en el path de roles (`/v1/brand//plan/slug/`) da 404 →
    // `false`, indistinguible de un canal caído: sin esta guarda la fila no
    // vencería NUNCA. Misma decisión que `efectoRoles` en el webhook.
    it('una fila sin brandId/planSlug no llama a roles pero igual vence', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora({ brandId: '', planSlug: '' })])

      await service.expireSubscriptions()

      expect(clientRoles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
      )
    })
  })


  /**
   * `retiro-de-plan-al-vencer-el-periodo` (épica 002, criterio 3).
   *
   * Desde el corte diferido, la baja NO mueve el `status`: sella `accessEndsAt` y
   * apaga la renovación, y la fila sigue viva —`trial`/`active`/`past_due`— con el
   * plan pago puesto hasta que llegue esa fecha. Nadie la cerraba: `accessEndsAt`
   * sólo tenía escritores. Este cron es su único lector.
   *
   * Rojo si: se quita `assignPlanToBrand(brandId, FREE_PLAN_SLUG)` de
   * `downgradeBrandToFree` (la mutación de control que comparten los disparadores).
   */
  describe('expireCancelledSubscriptions', () => {
    const finDeAcceso = new Date('2026-08-27T10:00:00.000Z')

    const dadaDeBaja = (over: Record<string, any> = {}) => ({
      id: 's1',
      brandId: 'b1',
      planSlug: 'pro',
      status: SubscriptionStatus.ACTIVE,
      autoRenew: false,
      retryCount: 0,
      cancelledAt: new Date('2026-08-20T10:00:00.000Z'),
      accessEndsAt: finDeAcceso,
      currentPeriodEnd: new Date('2026-09-20T10:00:00.000Z'),
      ...over,
    })

    /**
     * El compare-and-set del cron, que tiene CUATRO condiciones y no tres: además
     * del estado leído y `autoRenew: false`, repite la cota temporal de la consulta
     * (`accessEndsAt < ahora`). Sin ella una pasada vieja podía cerrar una baja
     * DISTINTA —la fila se reactivó y se volvió a dar de baja con fecha futura— y
     * borrarle una fecha de corte todavía por venir.
     */
    const esperarCierre = (status: SubscriptionStatus, llamada = 0) => {
      const [criterio, cambio] = subscriptionRepo.update.mock.calls[llamada]
      expect(criterio.id).toBe('s1')
      expect(criterio.status).toBe(status)
      expect(criterio.autoRenew).toBe(false)
      expect(criterio.accessEndsAt.type).toBe('lessThan')
      expect(criterio.accessEndsAt.value).toBeInstanceOf(Date)
      expect(cambio).toEqual({ status: SubscriptionStatus.CANCELLED, accessEndsAt: null })
    }

    it('vencido el acceso pagado saca el plan pago y deja free', async () => {
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])

      await service.expireCancelledSubscriptions()

      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
      // `free` SIN `expiresAt`: un plan que no se cobra no vence.
      expect(clientRoles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
      expect(clientRoles.removePlanFromBrand.mock.invocationCallOrder[0]).toBeLessThan(
        clientRoles.assignPlanToBrand.mock.invocationCallOrder[0],
      )
      // Compare-and-set contra el estado vigente: dos pasadas solapadas no cierran
      // la fila dos veces. `accessEndsAt: null` porque la invariante de la entidad
      // dice «no nula ⇔ baja PENDIENTE» y acá la baja se acaba de consumar.
      esperarCierre(SubscriptionStatus.ACTIVE)
      expect(subscriptionEventRepo.create).toHaveBeenCalledTimes(1)
      expect(eventBus.publishSubscriptionExpired).toHaveBeenCalledTimes(1)
    })

    // La fecha de corte se borra en el mismo CAS, así que el evento es el ÚNICO
    // rastro de hasta cuándo corrió el acceso pagado: `cancelledAt` es la fecha de
    // la BAJA, no la del corte. Rojo si el `metadata` se arma después de nular.
    it('deja en la traza hasta cuándo corrió el acceso pagado', async () => {
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])

      await service.expireCancelledSubscriptions()

      expect(subscriptionEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: SubscriptionEventType.EXPIRED,
          fromStatus: SubscriptionStatus.ACTIVE,
          toStatus: SubscriptionStatus.CANCELLED,
          triggeredBy: 'system',
          metadata: expect.objectContaining({
            event: 'subscription.access_ended',
            accessEndsAt: finDeAcceso.toISOString(),
            brandId: 'b1',
            planSlug: 'pro',
          }),
        }),
      )
    })

    // El dueño del aviso «tu plan venció» para filas con baja sellada pasa a ser
    // este cron: `sendExpirationWarnings` corre a las 9am y para entonces la fila
    // ya está cerrada y sin `accessEndsAt`, o sea que no matchea ninguna rama.
    it('avisa que el plan venció, después de cerrar la fila', async () => {
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])

      await service.expireCancelledSubscriptions()

      expect(eventBus.notifySubscriptionExpired).toHaveBeenCalledTimes(1)
      expect(eventBus.notifySubscriptionExpired).toHaveBeenCalledWith('b1', 'pro')
      expect(subscriptionRepo.update.mock.invocationCallOrder[0]).toBeLessThan(
        eventBus.notifySubscriptionExpired.mock.invocationCallOrder[0],
      )
    })

    // Pasada solapada: el compare-and-set no afecta filas, así que esta pasada no
    // escribe historial, no publica y —sobre todo— no manda un segundo aviso.
    it('una pasada solapada que ya cerró la fila no escribe ni avisa dos veces', async () => {
      subscriptionRepo.update.mockResolvedValue({ affected: 0 })
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])
      // La fila que dejó la otra pasada: cerrada y sin fecha de corte.
      subscriptionRepo.findOne.mockResolvedValue(
        dadaDeBaja({ status: SubscriptionStatus.CANCELLED, accessEndsAt: null }),
      )

      await service.expireCancelledSubscriptions()

      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
      expect(eventBus.notifySubscriptionExpired).not.toHaveBeenCalled()
      // Y NO le devuelve el plan pago a una marca legítimamente dada de baja: la
      // fila releída ya está cerrada.
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'pro', expect.anything())
    })

    /**
     * TOCTOU entre la degradación y el compare-and-set: la degradación corre sobre
     * la copia leída al principio y es HTTP con 10 s de timeout. Si en esa ventana
     * la fila se reactiva, roles YA se quedó sin el plan pago y con `free`, el CAS
     * no afecta nada y —sin reparación— una marca que paga se quedaba en `free` sin
     * traza local y sin ningún cron que la retome.
     *
     * Rojo si: el `affected: 0` se deja pasar de largo, o si se repone a ciegas sin
     * releer la fila.
     */
    it('si la fila revivió mientras se degradaba, repone el plan pago en roles', async () => {
      const periodoVigente = new Date('2026-09-20T10:00:00.000Z')
      subscriptionRepo.update.mockResolvedValue({ affected: 0 })
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])
      subscriptionRepo.findOne.mockResolvedValue({
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        status: SubscriptionStatus.ACTIVE,
        autoRenew: true,
        cancelledAt: null,
        accessEndsAt: null,
        currentPeriodEnd: periodoVigente,
      })

      await service.expireCancelledSubscriptions()

      // Con `expiresAt` —y el del período que hoy tiene pago, no el de la copia
      // vieja—: un plan pago SIN vencimiento no lo barre nunca el cron de roles.
      expect(clientRoles.assignPlanToBrand).toHaveBeenLastCalledWith('b1', 'pro', periodoVigente)
      expect(clientRoles.assignPlanToBrand.mock.calls[1]).toHaveLength(3)
      // La reparación es sólo del lado de roles: la fila local ya es correcta.
      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.notifySubscriptionExpired).not.toHaveBeenCalled()
    })

    // La baja se rehízo con una fecha de corte FUTURA: la fila tiene acceso pagado
    // por delante, así que el plan vuelve aunque `autoRenew` siga apagado.
    it('repone el plan si la nueva baja todavía tiene acceso por delante', async () => {
      const enUnMes = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      subscriptionRepo.update.mockResolvedValue({ affected: 0 })
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])
      subscriptionRepo.findOne.mockResolvedValue({
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        status: SubscriptionStatus.ACTIVE,
        autoRenew: false,
        cancelledAt: new Date(),
        accessEndsAt: enUnMes,
        currentPeriodEnd: enUnMes,
      })

      await service.expireCancelledSubscriptions()

      expect(clientRoles.assignPlanToBrand).toHaveBeenLastCalledWith('b1', 'pro', enUnMes)
    })

    /**
     * ⚠️ ACCESO SIN PAGO — el caso que obliga a que «sigue con derecho» sea una lista
     * CERRADA de estados vivos y no «no es terminal».
     *
     * La tabla tiene índice único por `brandId`, así que el alta paga que entra en la
     * ventana TOCTOU no crea otra fila: REUSA ésta y la deja `pending` con
     * `autoRenew: true`. Con un predicado negativo (`!TERMINAL…`) `pending` cae del
     * lado del derecho y el reponedor le devuelve el plan PAGO a una fila que todavía
     * no pagó su primer ciclo: entitlement regalado.
     *
     * MUTACIÓN QUE LO PONE ROJO: volver el predicado de `reponerPlanSiSigueVigente` a
     * `!TERMINAL_SUBSCRIPTION_STATUSES.includes(vigente.status)` ⇒ se llama a
     * `assignPlanToBrand('b1', 'pro', …)`.
     */
    it('NO repone el plan pago si la fila quedó `pending`: todavía no pagó nada', async () => {
      subscriptionRepo.update.mockResolvedValue({ affected: 0 })
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])
      subscriptionRepo.findOne.mockResolvedValue({
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        status: SubscriptionStatus.PENDING,
        autoRenew: true,
        cancelledAt: null,
        accessEndsAt: null,
        currentPeriodEnd: new Date('2026-09-20T10:00:00.000Z'),
      })

      await service.expireCancelledSubscriptions()

      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'pro', expect.anything())
    })

    // Intersección de los dos crons horarios: una fila dada de baja MIENTRAS estaba
    // en mora cae en las dos consultas. Dueño único: `expireSubscriptions`, que ya
    // existía y tiene la causa de negocio más específica (reintentos agotados).
    it('la mora con reintentos agotados es de expireSubscriptions, no de este cron', async () => {
      subscriptionRepo.find.mockResolvedValue([
        dadaDeBaja({ status: SubscriptionStatus.PAST_DUE, retryCount: 3 }),
      ])

      await service.expireCancelledSubscriptions()

      expect(clientRoles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.update).not.toHaveBeenCalled()
      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
      expect(eventBus.notifySubscriptionExpired).not.toHaveBeenCalled()
    })

    it('la mora con reintentos disponibles sí la cierra este cron', async () => {
      subscriptionRepo.find.mockResolvedValue([
        dadaDeBaja({ status: SubscriptionStatus.PAST_DUE, retryCount: 0 }),
      ])

      await service.expireCancelledSubscriptions()

      esperarCierre(SubscriptionStatus.PAST_DUE)
    })

    it('si roles rechaza el retiro no cierra la fila y la pasada siguiente reintenta', async () => {
      clientRoles.removePlanFromBrand.mockResolvedValue(false)
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])

      await service.expireCancelledSubscriptions()

      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.update).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
      expect(eventBus.notifySubscriptionExpired).not.toHaveBeenCalled()

      // La fila sigue viva con su fecha de corte sellada: el cron la vuelve a tomar
      // y, con roles de pie, la degrada. Idempotencia por reintento.
      clientRoles.removePlanFromBrand.mockResolvedValue(true)
      await service.expireCancelledSubscriptions()

      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
      esperarCierre(SubscriptionStatus.ACTIVE)
    })

    /**
     * La otra mitad de «roles rechaza»: el retiro SÍ pasa y falla la asignación de
     * `free` (`plan-downgrade.util.ts`). El `false` es el mismo, pero el estado del
     * otro lado no: la marca quedó sin NINGÚN plan. Ese hueco es deliberado —dejar
     * el plan pago puesto y `free` encima es peor—, y lo que lo cierra es que acá no
     * se escriba NADA local, para que la pasada siguiente rehaga las DOS llamadas.
     */
    it('si falla la asignación de free tampoco escribe, y la pasada siguiente rehace las dos llamadas', async () => {
      clientRoles.assignPlanToBrand.mockResolvedValue(false)
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja()])

      await service.expireCancelledSubscriptions()

      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledTimes(1)
      expect(subscriptionRepo.update).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
      expect(eventBus.notifySubscriptionExpired).not.toHaveBeenCalled()

      clientRoles.assignPlanToBrand.mockResolvedValue(true)
      await service.expireCancelledSubscriptions()

      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledTimes(2)
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledTimes(2)
      esperarCierre(SubscriptionStatus.ACTIVE)
    })

    // La consulta ES el contrato: qué filas toma este cron y cuántas por pasada. Se
    // asserta el argumento, no el resultado — verificarlo devolviendo filas desde un
    // repo falso que implemente el mismo filtro probaría el doble.
    it('toma sólo bajas selladas ya vencidas, acotadas y en orden', async () => {
      await service.expireCancelledSubscriptions()

      const [args] = subscriptionRepo.find.mock.calls[0]
      const [vivas, mora] = args.where

      expect(Object.keys(vivas).sort()).toEqual(['accessEndsAt', 'autoRenew', 'status'])
      expect(vivas.autoRenew).toBe(false)
      expect(vivas.status.value).toEqual([SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE])
      expect(vivas.accessEndsAt.type).toBe('lessThan')
      expect(vivas.accessEndsAt.value).toBeInstanceOf(Date)

      // La mora entra por su propia rama y con los reintentos DISPONIBLES: la
      // agotada es de `expireSubscriptions`. Filtrarla recién en el loop la dejaba
      // gastando la cota de 200 en cada pasada —y con el orden por fecha, primero—,
      // así que una baja nueva podía no degradarse nunca.
      expect(mora.status).toBe(SubscriptionStatus.PAST_DUE)
      expect(mora.retryCount.type).toBe('lessThan')
      expect(mora.retryCount.value).toBe(3)
      expect(mora.autoRenew).toBe(false)
      expect(mora.accessEndsAt.type).toBe('lessThan')

      // Un solo reloj para toda la pasada: la consulta y el compare-and-set exigen
      // el MISMO instante.
      expect(mora.accessEndsAt.value).toBe(vivas.accessEndsAt.value)

      // La cota es parte del contrato, no una optimización: una pasada sin cota se
      // solapa consigo misma mientras backend-roles esté lento.
      expect(args.take).toBe(200)
      expect(args.order.accessEndsAt).toBe('ASC')
    })

    // El CAS respeta el estado vigente en vez de un `active` hardcodeado: una baja
    // sellada durante la prueba cierra desde `trial`.
    it('una fila en prueba se cierra desde trial', async () => {
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja({ status: SubscriptionStatus.TRIAL })])

      await service.expireCancelledSubscriptions()

      esperarCierre(SubscriptionStatus.TRIAL)
    })

    // Un segmento vacío en el path de roles da 404 → `false`, indistinguible de un
    // canal caído: sin esta guarda la fila no se cerraría NUNCA.
    it('una fila sin brandId/planSlug no llama a roles pero igual se cierra', async () => {
      subscriptionRepo.find.mockResolvedValue([dadaDeBaja({ brandId: '', planSlug: '' })])

      await service.expireCancelledSubscriptions()

      expect(clientRoles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      esperarCierre(SubscriptionStatus.ACTIVE)
    })
  })

  describe('reconcileExternalPayments', () => {
    it('completa un pago confio pendiente cuyo estado real es completed', async () => {
      paymentRepo.find.mockResolvedValue([
        { id: 'pay-9', provider: 'confio', status: 'pending', providerPaymentId: 'stores/x/payments/y' },
      ])
      providerFactory.getProvider.mockReturnValue({
        getPaymentStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
      })

      await service.reconcileExternalPayments()

      expect(checkoutService.completeExternalPayment).toHaveBeenCalledWith('pay-9', { source: 'cron-reconcile' })
    })

    it('NO completa si el estado real sigue pending', async () => {
      paymentRepo.find.mockResolvedValue([
        { id: 'pay-9', provider: 'confio', status: 'pending', providerPaymentId: 'stores/x/payments/y' },
      ])
      providerFactory.getProvider.mockReturnValue({
        getPaymentStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
      })

      await service.reconcileExternalPayments()

      expect(checkoutService.completeExternalPayment).not.toHaveBeenCalled()
    })
  })

  /**
   * El aviso «tu acceso termina en N días» se agendaba contra `currentPeriodEnd` y
   * sólo para filas `active`. Con el corte diferido esa fecha ya no es la que manda:
   * una baja sella `accessEndsAt`, que para una fila en PRUEBA es `trialEnd` —otro
   * día— y deja la fila en `trial`, fuera del filtro de estado. El aviso salía tarde
   * o no salía.
   *
   * Rojo si: la consulta vuelve a mirar sólo `currentPeriodEnd` + `active`.
   */
  describe('sendExpirationWarnings', () => {
    it('agenda por la fecha de fin de acceso cuando la baja ya está sellada', async () => {
      await service.sendExpirationWarnings()

      // Una pasada = un aviso por cada hito (7, 3, 1 y 0 días).
      expect(subscriptionRepo.find).toHaveBeenCalledTimes(4)
      const [porAcceso, porPeriodo] = subscriptionRepo.find.mock.calls[0][0].where

      // Rama nueva: la baja pendiente manda, en CUALQUIER estado vigente.
      expect(porAcceso.autoRenew).toBe(false)
      expect(porAcceso.accessEndsAt).toBeDefined()
      expect(porAcceso.currentPeriodEnd).toBeUndefined()
      expect(porAcceso.status.value).toEqual([
        SubscriptionStatus.TRIAL,
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.PAST_DUE,
      ])

      // Rama de siempre, intacta: sin fecha de corte sellada se agenda por período.
      expect(porPeriodo.autoRenew).toBe(false)
      expect(porPeriodo.currentPeriodEnd).toBeDefined()
      expect(porPeriodo.status.value).toEqual([SubscriptionStatus.ACTIVE])
    })

    // El aviso de día 0 por `accessEndsAt` ya no se agenda acá: para las 9am toda
    // fila con baja sellada que venció entre 00:00 y 09:00 la cerró
    // `expireCancelledSubscriptions`, que ya avisó en la hora real del corte. La
    // rama de `currentPeriodEnd` —filas SIN baja sellada, que ese cron nunca toca
    // porque `LessThan` excluye NULL— conserva su aviso de día 0.
    it('cede el aviso de día 0 por fin de acceso y conserva el de período', async () => {
      await service.sendExpirationWarnings()

      expect(subscriptionRepo.find).toHaveBeenCalledTimes(4)
      const dia0 = subscriptionRepo.find.mock.calls[3][0].where
      expect(dia0).toHaveLength(1)
      expect(dia0[0].currentPeriodEnd).toBeDefined()
      expect(dia0[0].accessEndsAt).toBeDefined()
      expect(dia0[0].status.value).toEqual([SubscriptionStatus.ACTIVE])

      // Los hitos previos (7, 3 y 1 días) conservan sus dos ramas.
      for (const i of [0, 1, 2]) {
        expect(subscriptionRepo.find.mock.calls[i][0].where).toHaveLength(2)
      }
    })
  })

  /**
   * ⚠️ DINERO. `pending` es el alta PAGA que todavía no aceptó su link INICIAL. Los
   * dos barridos de acá emiten un link de cobro REAL (`issueExternalCharge`), así que
   * dejarla entrar le abriría un SEGUNDO riel de cobro para el mismo primer período.
   * Que hoy no entre no es casualidad: las consultas ENUMERAN estados y el loop tiene
   * además su propio guard. Se fijan los dos, porque son defensas independientes.
   */
  describe('ningún barrido que emite cobro incluye `pending`', () => {
    // MUTACIÓN QUE LO PONE ROJO: agregar `SubscriptionStatus.PENDING` a cualquiera de
    // los dos criterios de estado ⇒ la fila `pending` entra al barrido que cobra.
    it('el criterio de estado de los dos barridos es una lista cerrada sin `pending`', async () => {
      await service.processSubscriptionRenewals()
      expect(subscriptionRepo.find.mock.calls[0][0].where.status).toEqual(
        In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
      )

      subscriptionRepo.find.mockClear()

      await service.retryFailedPayments()
      expect(subscriptionRepo.find.mock.calls[0][0].where.status).toBe(SubscriptionStatus.PAST_DUE)
    })

    // Defensa en profundidad, y conductual: aunque la consulta la dejara pasar, el
    // guard del loop (`sub.status === ACTIVE` para `confio`) impide el cobro.
    // MUTACIÓN QUE LO PONE ROJO: aflojar ese guard a `sub.status !== TRIAL`.
    it('una fila `pending` que llegara igual al loop no dispara el cobro', async () => {
      subscriptionRepo.find.mockResolvedValue([
        {
          id: 's-pending',
          brandId: 'b1',
          userId: 'u1',
          planSlug: 'dropi-roax',
          provider: 'confio',
          status: SubscriptionStatus.PENDING,
          autoRenew: true,
        },
      ])

      await service.processSubscriptionRenewals()

      expect(checkoutService.processCheckout).not.toHaveBeenCalled()
    })
  })
})
