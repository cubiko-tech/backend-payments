import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { ConfioPlanService } from './confio-plan.service'
import { ClientRolesService } from '../../client/client-roles.service'
import { logger } from '../../shared/logger/logger'

/**
 * The plan whose catalog price is MADE UP and so cannot be compared: `getPlanPriceCents`
 * invents `COP 0` and `USD 0` for `free` when it has no rows (the
 * `rows.length === 0 && planSlug === 'free'` branch in `client-roles.service.ts`).
 *
 * El literal se repite en vez de usar `freePlanSlug()` porque no es el mismo
 * concepto: `freePlanSlug()` es el plan al que se degrada una marca —una
 * decisión de negocio configurable por entorno— y esto es la clave con la que
 * aquella rama está escrita, hardcodeada allá. Si el plan de degradación
 * cambiara de nombre, el cero seguiría fabricándose para `free`.
 */
const SLUG_CON_PRECIO_FABRICADO = 'free'

/**
 * Avisa cuando el precio del catálogo (`plan_prices` de backend-roles) se separó
 * del `amountCents` con el que se creó el plan equivalente en ConfioPagos.
 *
 * **Por qué avisa y no corrige.** Un plan de ConfioPagos no se puede editar ni
 * borrar: verificado contra su API el 2026-09-04, `PATCH`, `PUT` y `DELETE`
 * sobre un plan que responde `GET 200` dan los tres 404, y su spec no tiene
 * endpoint de actualización. La única «corrección» posible es crear otro plan y
 * re-mapearlo, y eso es irreversible: no puede ser el efecto colateral de un
 * chequeo que corre solo a las 6am.
 *
 * **Y por qué tampoco migra nada.** Un cambio de precio no es un `UPDATE` sino
 * una CONVIVENCIA: las suscripciones vivas apuntan al recurso del plan con el
 * que nacieron y siguen cobrando el monto viejo hasta que se den de baja y se
 * vuelvan a suscribir. No hay forma de moverlas, así que el objetivo acá es que
 * alguien se entere, no que el sistema se arregle solo.
 *
 * Mismo patrón que `reconcileWalletBalances` (`tasks.service.ts:818`): detecta
 * el descuadre, lo loguea en `error` y no lo toca. Sólo lee —`ConfioPlanService`
 * y `ClientRolesService`, las dos puertas de lectura— y no altera ningún alta:
 * ninguna suscripción se rechaza, se demora ni cambia de precio por lo que este
 * chequeo encuentre.
 */
@Injectable()
export class ConfioPlanPriceCheckService {
  constructor(
    private readonly planes: ConfioPlanService,
    private readonly clientRoles: ClientRolesService,
  ) {}

  /**
   * Recorre los mapeos y compara cada uno contra el precio vigente de SU moneda.
   *
   * The mapping is keyed by currency, not country: `resolvePriceForCountry` is keyed by
   * country, and the reader by currency is `getPlanPriceCents(planSlug, currency)`, which
   * picks the same row among several of one currency whatever their order.
   *
   * Las dos variantes `withTrial` de una misma moneda comparan contra el mismo
   * precio: la prueba cambia de plan, no de monto.
   */
  @Cron('0 6 * * *')
  async verificarPreciosContraElCatalogo(): Promise<void> {
    try {
      const filas = await this.planes.findAllMappings()

      let comparadas = 0
      let divergentes = 0
      let omitidas = 0

      for (const fila of filas) {
        // Sin plan del otro lado no hay divergencia: todavía no hay nada
        // cobrando el monto viejo. Hoy éste es el estado de las cuatro filas de
        // producción, así que sin este filtro la primera pasada las reporta
        // todas y el aviso deja de significar algo.
        if (
          fila.status !== 'active' ||
          !fila.confioName ||
          fila.planSlug === SLUG_CON_PRECIO_FABRICADO
        ) {
          omitidas++
          continue
        }

        const esperadoCents = await this.clientRoles.getPlanPriceCents(
          fila.planSlug,
          fila.currencyCode,
        )

        // `null` es «no sé», no «cero». `getPlanRows` degrada a caché vencido o a
        // un `Map` vacío cuando backend-roles falla, y leer ese vacío como precio
        // marcaría las cuatro filas de golpe: un fallo del canal no es un hecho
        // sobre el objeto.
        if (esperadoCents === null || esperadoCents === undefined) {
          omitidas++
          continue
        }

        comparadas++

        if (esperadoCents !== fila.amountCents) {
          divergentes++
          const variante = fila.withTrial ? 'con prueba' : 'sin prueba'
          logger.log(
            'error',
            `[CRON] DIVERGENCIA de precio en ${fila.planSlug}/${fila.currencyCode} (${variante}, ` +
              `${fila.confioName}): el plan de ConfioPagos cobra ${fila.amountCents} centavos y el ` +
              `catálogo vale ${esperadoCents}. No se corrige sola: un plan de ConfioPagos ` +
              `no se puede editar, hay que crear otro y re-mapearlo, y las suscripciones vivas siguen ` +
              `cobrando el monto viejo hasta que se den de baja.`,
          )
        }
      }

      logger.log(
        'info',
        `[CRON] verificarPreciosContraElCatalogo: ${comparadas} comparadas, ` +
          `${divergentes} divergentes, ${omitidas} sin comparar`,
      )
    } catch (error) {
      // Mensaje DISTINTO del de divergencia a propósito (precedente `MetricsCron`):
      // una caída de la lectura no es un descuadre de precio, y tampoco puede
      // tumbar el scheduler.
      logger.log(
        'error',
        `[CRON] verificarPreciosContraElCatalogo: error al verificar precios: ${error.message}`,
      )
    }
  }
}
