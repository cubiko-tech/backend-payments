import { Subscription } from '../subscription/entities/subscription.entity'

/**
 * Período de cobro: el trío de fechas que una renovación escribe en la fila.
 *
 * Vive acá y no en el handler porque lo consumen las DOS fases del webhook —la
 * de decisión, que se lo promete a `backend-roles` como `expiresAt`, y la de
 * aplicación, que lo persiste—, y porque `confio-subscription-webhook.service.ts`
 * ya está en el límite de tamaño del repo (400 líneas).
 */
export interface PeriodoConfio {
  start: Date
  end: Date
  nextBilling: Date
}

/** `Date` utilizable, o `undefined`. Un `Invalid Date` NO es utilizable. */
export function aFecha(valor: Date | string | undefined): Date | undefined {
  if (!valor) return undefined
  const fecha = valor instanceof Date ? valor : new Date(valor)

  return isNaN(fecha.getTime()) ? undefined : fecha
}

/** Un mes calendario, recortado al último día cuando el destino es más corto. */
export function sumarUnCicloMensual(desde: Date): Date {
  const fin = new Date(desde.getTime())
  const dia = fin.getUTCDate()
  fin.setUTCMonth(fin.getUTCMonth() + 1)
  if (fin.getUTCDate() < dia) fin.setUTCDate(0)

  return fin
}

/** Un período cuyo fin ya pasó: no se le puede prometer acceso a nadie. */
export function estaVencido(fin: Date): boolean {
  return fin.getTime() <= Date.now()
}

/**
 * Avance LOCAL: un ciclo mensual desde el fin del período anterior, con PISO en
 * el ahora.
 *
 * Es el respaldo de cuando ConfioPagos no da período (sin resource name, sin
 * respuesta o con una respuesta incompleta).
 *
 * El piso NO es cosmético. Un cobro fallido NO avanza el período, así que la
 * recuperación puede llegar más de un ciclo después del último período pagado
 * (`currentPeriodEnd` viejo + un mes = una fecha en el PASADO). Sin piso, ese
 * fin vencido se filtra a los dos lados del efecto y falla en silencio:
 *
 * 1. `assignPlanToBrand(brand, plan, <fecha vencida>)` crea el vínculo y el cron
 *    de `backend-roles` (`tasks.service.ts:71`, `expiresAt < now`) lo barre acto
 *    seguido: el cliente pagó, la suscripción queda `active`, el historial dice
 *    `reponer` y el acceso pro NUNCA vuelve.
 * 2. `nextBillingDate` en el pasado despierta a `processSubscriptionRenewals`
 *    (⚠️ DINERO, `tasks.service.ts:176-200`).
 *
 * Con piso, el ciclo se cuenta desde el pago: un mes de servicio a partir de
 * ahora, que es lo honesto cuando el proveedor no dice nada. El aniversario lo
 * vuelve a fijar el propio proveedor en el cobro siguiente, que es la fuente de
 * verdad del período; acá sólo se cubre el hueco.
 */
export function periodoLocal(sub: Subscription): PeriodoConfio {
  const ahora = new Date()
  const anterior = aFecha(sub.currentPeriodEnd)
  // El piso cubre de una vez los dos casos: la fila sin `currentPeriodEnd` (o
  // con uno inválido) y la fila cuyo período ya venció hace rato.
  const inicio = anterior && anterior.getTime() > ahora.getTime() ? anterior : ahora
  const fin = sumarUnCicloMensual(inicio)

  return { start: inicio, end: fin, nextBilling: fin }
}
