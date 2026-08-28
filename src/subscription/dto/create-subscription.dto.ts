import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator'
import { SubscriptionProvider, SubscriptionStatus } from '../entities/subscription.entity'

/**
 * Lista BLANCA del alta genérica (`POST /subscription` → `SubscriptionService.create`).
 *
 * No es cosmética ni documentación: es el candado. `create()` hace
 * `repository.create(data)` + `save(data)` con el body tal cual, así que **lo que
 * esta clase declara es exactamente lo que un llamador puede escribir en la fila**.
 * Antes el handler recibía `@Body() data: any`: sin metatype el `ValidationPipe`
 * global de `main.ts` (`whitelist` + `forbidNonWhitelisted`) no filtra NADA, y el
 * body entraba entero. Dos agujeros concretos que eso abría:
 *   · `id` — es `@PrimaryGeneratedColumn('uuid')`, así que un `id` ajeno convierte
 *     el `save` en un UPDATE de la fila de OTRA marca (el `id` se consigue con el
 *     `GET /subscription?brandId=` de al lado). Sin `id` en la lista, `save` sólo
 *     puede INSERTAR, y el índice único por `brandId` rechaza la fila repetida.
 *   · `trialStart` / `trialEnd` — son la marca DURABLE de prueba consumida (la
 *     invariante completa vive al lado de las columnas en `subscription.entity.ts`).
 *     Poderlas mandar en `null` devolvía la prueba gratis: después de eso
 *     `POST /subscription/trial` pasa sus dos guards y regala un segundo trial.
 * Por eso NO se declaran acá, y por eso tampoco se declaran `cancelledAt`,
 * `accessEndsAt`, `retryCount` ni `lastPaymentId`: son sellos que escriben los
 * caminos de dominio (baja, crons, checkout), nunca el llamador.
 *
 * ⚠️ Agregar un campo acá es dar permiso de escritura sobre esa columna a
 * cualquiera que esté autenticado. `providerSubscriptionId` está en la lista
 * porque un alta de otra pasarela lo necesita, y el resource name que trae lo
 * revalida `ConfioProvider.assertSubscriptionPath` antes de interpolarlo.
 */
export class CreateSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  brandId: string

  @IsString()
  @IsNotEmpty()
  userId: string

  @IsString()
  @IsNotEmpty()
  planSlug: string

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus

  @IsOptional()
  @IsEnum(SubscriptionProvider)
  provider?: SubscriptionProvider

  @IsOptional()
  @IsUUID()
  walletId?: string

  @IsOptional()
  @IsString()
  providerSubscriptionId?: string

  @IsOptional()
  @IsDateString()
  currentPeriodStart?: string

  @IsOptional()
  @IsDateString()
  currentPeriodEnd?: string

  @IsOptional()
  @IsDateString()
  nextBillingDate?: string

  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>
}
