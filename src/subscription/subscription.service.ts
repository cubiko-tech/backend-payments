import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { Subscription, SubscriptionStatus, SubscriptionProvider } from './entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from './entities/subscriptionEvent.entity'
import { ClientRolesService } from '../client/client-roles.service'
import { EventBusService } from '../event-bus/event-bus.service'
import { RequestException } from '../shared/exception/request.exception'

// Estados en los que la marca tiene servicio vigente; `expired` y `cancelled` son ciclos
// terminados y no deben bloquear un alta nueva.
const LIVE_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.TRIAL,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
]

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name)

  constructor(
    @InjectRepository(Subscription, 'DBWrite')
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(Subscription, 'DBRead')
    private readonly subscriptionReadRepository: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent, 'DBWrite')
    private readonly subscriptionEventRepository: Repository<SubscriptionEvent>,
    @InjectRepository(SubscriptionEvent, 'DBRead')
    private readonly subscriptionEventReadRepository: Repository<SubscriptionEvent>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    private readonly clientRoles: ClientRolesService,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * Iniciar un trial gratuito (sin método de pago).
   *
   * Crea la suscripción en estado TRIAL por TRIAL_DAYS días, asigna el plan
   * en backend-roles con expiración = fin del trial, y deja `nextBillingDate`
   * en la fecha de vencimiento para que el cron de conversión la tome.
   * Al vencer: si hay método de pago se cobra; si no, se degrada a `free`
   * (ver TasksService.processTrialConversions).
   *
   * La prueba es una sola por marca: si ya se consumió, el alta se rechaza y la
   * marca solo puede volver por el checkout pago. En cambio, una suscripción
   * vencida o cancelada que nunca la usó sí puede iniciarla, reusando su fila.
   */
  async startTrial(input: {
    brandId: string
    userId: string
    planSlug: string
    provider?: SubscriptionProvider
    walletId?: string
  }) {
    const { brandId, userId, planSlug } = input

    const freePlan = process.env.FREE_PLAN_SLUG || 'free'
    if (!planSlug || planSlug === freePlan) {
      throw new RequestException(
        { code: 'INVALID_TRIAL_PLAN', message: 'El trial requiere un plan de pago válido' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // Se lee del repo de ESCRITURA porque a partir de acá el alta hace read-modify-write
    // sobre la fila (la reusa si el ciclo anterior está muerto) y la réplica podría estar
    // atrasada; `cancel()` y `reactivate()` ya usan el repo de escritura por lo mismo.
    // Deudas que NO se resuelven acá: (1) no hay transacción ni lock, así que dos POST
    // simultáneos pasan ambos el guard —con marca nueva el índice único ataja la segunda
    // inserción, pero al reusar la fila los dos hacen UPDATE y quedan dos TRIAL_STARTED
    // (Importante #5 de docs/REVISION_TRIAL_CONFIO_2026-06-30.md); (2) `create()` y el
    // checkout siguen creando suscripciones sin pasar por acá, así que esto es la barrera
    // del alta, no una invariante de dominio.
    const existing = await this.subscriptionRepository.findOne({ where: { brandId } })

    // Con servicio vigente no hay nada que iniciar: se conserva el código de siempre.
    if (existing && LIVE_SUBSCRIPTION_STATUSES.includes(existing.status)) {
      throw new RequestException(
        {
          code: 'SUBSCRIPTION_ALREADY_EXISTS',
          message: 'La marca ya tiene una suscripción vigente',
        },
        HttpStatus.CONFLICT,
      )
    }

    // `trialStart` es la marca durable de prueba consumida: ningún camino la limpia
    // (el checkout revive la fila sin tocar `trialStart`/`trialEnd` y el cron de
    // expiración solo mueve el estado a EXPIRED).
    if (existing && existing.trialStart) {
      throw new RequestException(
        {
          code: 'TRIAL_ALREADY_USED',
          message: 'La marca ya usó su prueba gratuita; para volver a suscribirse hay que pagar el plan',
        },
        HttpStatus.CONFLICT,
      )
    }

    const trialDays = parseInt(process.env.TRIAL_DAYS || '15')
    const now = new Date()
    const trialEnd = new Date(now)
    trialEnd.setDate(trialEnd.getDate() + trialDays)

    try {
      // Si la marca ya tenía una fila muerta se reusa (el índice único por brandId impide
      // una segunda) y se resetean los residuos del ciclo anterior para no arrastrarlos.
      const subscription = this.subscriptionRepository.create({
        ...(existing ? { id: existing.id } : {}),
        brandId,
        userId,
        planSlug,
        status: SubscriptionStatus.TRIAL,
        provider: input.provider || SubscriptionProvider.WALLET,
        walletId: input.walletId || null,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
        trialStart: now,
        trialEnd,
        nextBillingDate: trialEnd,
        autoRenew: true,
        cancelledAt: null,
        cancelReason: null,
        retryCount: 0,
        lastPaymentId: null,
        providerSubscriptionId: null,
      })
      const saved = await this.subscriptionRepository.save(subscription)

      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: saved.id,
          eventType: SubscriptionEventType.TRIAL_STARTED,
          toPlanSlug: planSlug,
          // Deja reconstruible el reinicio: la fila puede acumular más de un ciclo.
          fromStatus: existing?.status ?? null,
          toStatus: SubscriptionStatus.TRIAL,
          triggeredBy: userId,
          reason: `Trial de ${trialDays} días iniciado`,
        }),
      )

      // Activar el plan en backend-roles durante el trial (expira al terminar el trial).
      await this.clientRoles.assignPlanToBrand(brandId, planSlug, trialEnd)

      // Notificar inicio del trial (backend-processes envía email/push).
      await this.eventBus.publishNotification({
        brandId,
        userId,
        type: 'trial_started',
        subject: `Tu prueba gratuita de ${trialDays} días ha comenzado`,
        metadata: { planSlug, trialEnd: trialEnd.toISOString() },
      })

      this.logger.log(
        `Trial iniciado: ${saved.id} marca ${brandId} plan ${planSlug} hasta ${trialEnd.toISOString()}`,
      )
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al iniciar trial de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Obtener la suscripción actual de una marca
   */
  async getCurrent(brandId: string) {
    try {
      const subscription = await this.subscriptionReadRepository.findOne({
        where: { brandId },
      })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener suscripción de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Crear una suscripción nueva
   */
  async create(data: Partial<Subscription>) {
    try {
      const subscription = this.subscriptionRepository.create(data)
      const saved = await this.subscriptionRepository.save(subscription)

      // Registrar evento de creación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: saved.id,
          eventType: SubscriptionEventType.CREATED,
          toPlanSlug: saved.planSlug,
          toStatus: saved.status,
          triggeredBy: saved.userId,
        }),
      )

      this.logger.log(`Suscripción creada: ${saved.id} para marca ${saved.brandId}`)
      return { data: saved }
    } catch (error) {
      this.logger.error(`Error al crear suscripción: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Cambiar de plan
   */
  async changePlan(brandId: string, newPlan: { planSlug: string; triggeredBy: string }) {
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      const subscription = await queryRunner.manager.findOne(Subscription, {
        where: { brandId },
      })

      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      const fromPlan = subscription.planSlug
      subscription.planSlug = newPlan.planSlug
      await queryRunner.manager.save(Subscription, subscription)

      // Registrar evento de cambio de plan
      await queryRunner.manager.save(SubscriptionEvent, {
        subscriptionId: subscription.id,
        eventType: SubscriptionEventType.PLAN_CHANGED,
        fromPlanSlug: fromPlan,
        toPlanSlug: newPlan.planSlug,
        triggeredBy: newPlan.triggeredBy,
      })

      await queryRunner.commitTransaction()
      this.logger.log(`Plan cambiado de ${fromPlan} a ${newPlan.planSlug} para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al cambiar plan de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }

  /**
   * Cancelar suscripción
   */
  async cancel(brandId: string, reason: { reason: string; triggeredBy: string }) {
    try {
      const subscription = await this.subscriptionRepository.findOne({ where: { brandId } })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      const fromStatus = subscription.status
      subscription.status = SubscriptionStatus.CANCELLED
      subscription.cancelledAt = new Date()
      subscription.cancelReason = reason.reason
      subscription.autoRenew = false
      await this.subscriptionRepository.save(subscription)

      // Registrar evento de cancelación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: subscription.id,
          eventType: SubscriptionEventType.CANCELLED,
          fromStatus,
          toStatus: SubscriptionStatus.CANCELLED,
          triggeredBy: reason.triggeredBy,
          reason: reason.reason,
        }),
      )

      // Remover plan de la marca en backend-roles
      await this.clientRoles.removePlanFromBrand(brandId, subscription.planSlug)

      this.logger.log(`Suscripción cancelada para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al cancelar suscripción de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Reactivar suscripción cancelada
   */
  async reactivate(brandId: string, triggeredBy: string) {
    try {
      const subscription = await this.subscriptionRepository.findOne({ where: { brandId } })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      if (subscription.status !== SubscriptionStatus.CANCELLED) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_CANCELLED', message: 'Solo se pueden reactivar suscripciones canceladas' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      const fromStatus = subscription.status
      subscription.status = SubscriptionStatus.ACTIVE
      subscription.cancelledAt = null
      subscription.cancelReason = null
      subscription.autoRenew = true
      await this.subscriptionRepository.save(subscription)

      // Registrar evento de reactivación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: subscription.id,
          eventType: SubscriptionEventType.REACTIVATED,
          fromStatus,
          toStatus: SubscriptionStatus.ACTIVE,
          triggeredBy,
        }),
      )

      this.logger.log(`Suscripción reactivada para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al reactivar suscripción de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Historial de eventos de suscripción de una marca
   */
  async getHistory(brandId: string) {
    try {
      const subscription = await this.subscriptionReadRepository.findOne({ where: { brandId } })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      const events = await this.subscriptionEventReadRepository.find({
        where: { subscriptionId: subscription.id },
        order: { createdAt: 'DESC' },
      })

      return { data: events }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener historial de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }
}
