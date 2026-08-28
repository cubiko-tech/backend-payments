import { Logger } from '@nestjs/common'

import { ClientRolesService } from './client-roles.service'

const logger = new Logger('PlanDowngrade')

/**
 * Slug del plan de destino, leído del entorno EN CADA LLAMADA.
 *
 * No se congela en una constante de módulo a propósito: `process.env` se lee al
 * importar y un test que quiera mover el destino ya no podría, porque el módulo
 * queda cacheado por Jest entre casos.
 */
export function freePlanSlug(): string {
  return process.env.FREE_PLAN_SLUG || 'free'
}

/**
 * Degradación de una marca al plan `free` en `backend-roles`: saca el plan pago
 * y deja el baseline gratuito (épica 002, `degradacion-a-free-y-baja-en-roles`).
 *
 * Es el ÚNICO lugar donde se arma ese movimiento, y lo comparten los tres
 * disparadores de «no hay cobro posible»: el webhook de ConfioPagos que reporta
 * la suscripción cancelada o vencida, el trial que vence sin método de pago y
 * `expireSubscriptions` con los reintentos agotados. Vive en un archivo propio,
 * como `confio-period.util.ts` y `confio-traza.util.ts`: es una función pura de
 * su dependencia, no entra en ningún módulo de Nest y así no hace crecer al
 * handler del webhook, que ya está 40% sobre la guía de 400 líneas del repo.
 *
 * Cinco cosas que no se leen del código:
 *
 * (1) **`free` va SIN `expiresAt`.** Un plan que no se cobra no vence; pasarle
 *     uno lo dejaría barrido por el cron de `backend-roles` y la marca quedaría
 *     sin NINGÚN plan. El candado es la aserción de aridad exacta
 *     (`mock.calls[0]).toHaveLength(2)`) en los tres specs.
 *
 * (2) **El retiro rechazado corta ANTES de asignar `free`.** `callRolesApi`
 *     (`client-roles.service.ts:323-357`) colapsa 404, 5xx, timeout y
 *     `SERVICE_ROLES` ausente en el MISMO `false`, así que un `false` acá no
 *     distingue «no estaba» de «se cayó el canal». Ante la duda se devuelve
 *     `false` y se reintenta entero: dejar el plan pago puesto y `free` encima
 *     es peor que volver a intentar.
 *
 * (3) **Reintentar es seguro**, y por eso los llamadores pueden devolver sin
 *     escribir nada local y dejar que la pasada siguiente lo retome:
 *     `removePlanFromBrand` es un `delete` por criterio
 *     (`backend-roles/src/data/brand-permission/brand-permission.service.ts:223`),
 *     no un 404 si el vínculo ya no está, y `assignPlanToBrandBySlug` (`:529`)
 *     es un upsert.
 *
 * (4) **La marca que YA está en `free` no se toca en absoluto.** El corte va
 *     ANTES del retiro y no después: `removePlanFromBrand(brand, 'free')` sin
 *     una asignación que lo reponga dejaría a la marca sin NINGÚN plan, o sea lo
 *     contrario del baseline que promete este helper. Es alcanzable —un trial
 *     sobre un plan de precio 0 existe: `tasks.service.ts` → `renewFromWallet`
 *     ramifica sobre `amount === 0`—, así que no es una rama teórica.
 *
 * (5) **Cómo comprobar que los tests muerden** (procedimiento ejercido y
 *     revertido al construir la tarea): quitar de acá la llamada
 *     `assignPlanToBrand(brandId, freePlanSlug())` ⇒ se ponen rojos los TRES
 *     disparadores, no uno solo.
 */
export async function downgradeBrandToFree(
  clientRoles: ClientRolesService,
  brandId: string,
  planSlug: string,
): Promise<boolean> {
  const traza = `brand=${brandId} plan=${planSlug}`
  const free = freePlanSlug()

  // La suscripción que muere YA era la del plan de destino: no hay plan pago que
  // sacar y el baseline gratuito tiene que quedar donde está. Se corta ACÁ, antes
  // del retiro, por el motivo de (4).
  if (planSlug === free) {
    logger.log(`La marca ya estaba en ${free}, no hay plan pago que retirar: ${traza}`)
    return true
  }

  if (!(await clientRoles.removePlanFromBrand(brandId, planSlug))) {
    logger.error(`No se pudo retirar el plan en backend-roles: ${traza}`)
    return false
  }

  if (!(await clientRoles.assignPlanToBrand(brandId, free))) {
    logger.error(`No se pudo asignar ${free} en backend-roles: ${traza}`)
    return false
  }

  logger.log(`Marca degradada a ${free} en backend-roles: ${traza}`)

  return true
}
