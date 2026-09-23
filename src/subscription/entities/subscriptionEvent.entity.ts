import { Column, Entity, ManyToOne, JoinColumn, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'
import { Subscription } from './subscription.entity'

/**
 * Los diez primeros valores nombran el ciclo LOCAL de la suscripción y ninguno
 * cambia de significado: hay filas guardadas con cada uno y reinterpretarlas
 * sería falsear historial ya escrito. `reactivated` sigue siendo el que escribe
 * `SubscriptionService.reactivate()` y `trial_started` el del alta con prueba.
 *
 * El par de CONFIRMACIÓN es otra cosa y por eso son valores propios: nombran el
 * momento en que el proveedor —hoy ConfioPagos— reporta el alta como aceptada, y
 * lo que los distingue entre sí es si esa confirmación TERMINÓ EN ACCESO o no.
 * Sin ellos el historial mentía: una suscripción que se confirmaba por primera
 * vez quedaba escrita como `reactivated` (medido en dev el 2026-09-04) y la
 * confirmación que no otorgaba, como `trial_started`. El POR QUÉ de una no
 * otorgada sigue viviendo en la columna `reason`; estos valores dicen el QUÉ.
 *
 * Agregar un valor acá exige la migración de tipo que lo agrega al enum de
 * Postgres (`ALTER TYPE ... ADD VALUE`), con el literal IDÉNTICO.
 */
export enum SubscriptionEventType {
  CREATED = 'created', PLAN_CHANGED = 'plan_changed', RENEWED = 'renewed',
  CANCELLED = 'cancelled', EXPIRED = 'expired', REACTIVATED = 'reactivated',
  PAYMENT_FAILED = 'payment_failed', PAYMENT_SUCCEEDED = 'payment_succeeded',
  TRIAL_STARTED = 'trial_started', TRIAL_ENDED = 'trial_ended',
  CONFIRMATION_GRANTED = 'confirmation_granted',
  CONFIRMATION_NOT_GRANTED = 'confirmation_not_granted',
}

@Entity('subscription_events')
@Index(['subscriptionId', 'createdAt'])
@Index(['eventType', 'createdAt'])
export class SubscriptionEvent {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column('uuid') subscriptionId: string
  @Column({ type: 'enum', enum: SubscriptionEventType }) eventType: SubscriptionEventType
  @Column({ nullable: true }) fromPlanSlug: string
  @Column({ nullable: true }) toPlanSlug: string
  @Column({ nullable: true }) fromStatus: string
  @Column({ nullable: true }) toStatus: string
  @Column() triggeredBy: string
  @Column({ type: 'text', nullable: true }) reason: string
  @Column({ type: 'uuid', nullable: true }) paymentId: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date

  @ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription
}
