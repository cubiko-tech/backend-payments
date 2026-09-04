import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ConfioSubscriptionPlan } from '../entities/confioSubscriptionPlan.entity'
import { RequestException } from '../../shared/exception/request.exception'

/**
 * Resolución `(planSlug, moneda, conPrueba) → resource name del plan en ConfioPagos`.
 *
 * Sólo lectura: la tabla `confio_subscription_plan` se siembra por migración y
 * el alta real de los planes del lado de ConfioPagos no pasa por acá. Es la
 * única puerta por donde el alta, el webhook y la cancelación deben averiguar
 * contra qué plan de la pasarela están operando.
 *
 * Falla explícito y con códigos distintos en vez de devolver `null`: un `null`
 * silencioso terminaría armando una URL `stores/{store}/subscription-plans/null`
 * y un 404 de ConfioPagos que no dice nada del problema real.
 */
@Injectable()
export class ConfioPlanService {
  private readonly logger = new Logger(ConfioPlanService.name)

  constructor(
    @InjectRepository(ConfioSubscriptionPlan, 'DBRead')
    private readonly planReadRepo: Repository<ConfioSubscriptionPlan>,
  ) {}

  /**
   * Devuelve el resource name (`stores/{store}/subscription-plans/{plan}`) del
   * plan de ConfioPagos que corresponde a nuestro plan en esa moneda.
   *
   * @throws CONFIO_PLAN_NOT_MAPPED  no hay fila para ese plan y esa moneda.
   * @throws CONFIO_PLAN_NOT_CREATED hay fila, pero el plan todavía no existe en
   *   ConfioPagos (`confioName` NULL). Distinto del anterior a propósito: acá el
   *   mapeo está bien y lo que falta es el alta del plan en la pasarela.
   * @throws CONFIO_PLAN_ARCHIVED    el mapeo quedó fuera de uso.
   *
   * @param conPrueba si el alta debe obtener el período de prueba de ConfioPagos.
   *   **Es obligatorio a propósito**: la prueba vive en el PLAN, así que elegir
   *   mal acá es regalar quince días que después ellos cobran. Sin valor por
   *   defecto, un llamador que se olvide no compila, en vez de caer en silencio
   *   al plan con prueba —que es exactamente el modo de fallo caro—.
   */
  async resolveConfioPlanName(
    planSlug: string,
    currencyCode: string,
    conPrueba: boolean,
  ): Promise<string> {
    const currency = (currencyCode || '').trim().toUpperCase()

    const mapping = await this.planReadRepo.findOne({
      where: { planSlug, currencyCode: currency, withTrial: conPrueba },
    })

    // La variante se nombra en TODOS los mensajes de error: sin ella, «no hay plan
    // mapeado para dropi-roax/COP» manda a mirar una fila que sí existe, y el
    // tiempo se va en no entender por qué falla algo que está sembrado.
    const variante = conPrueba ? 'con prueba' : 'sin prueba'

    if (!mapping) {
      this.logger.warn(`Sin plan de ConfioPagos mapeado para ${planSlug}/${currency} (${variante})`)
      throw new RequestException(
        {
          code: 'CONFIO_PLAN_NOT_MAPPED',
          message:
            `El plan ${planSlug} no tiene plan de ConfioPagos mapeado para la moneda ` +
            `${currency} en su variante ${variante}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    if (mapping.status === 'archived') {
      throw new RequestException(
        {
          code: 'CONFIO_PLAN_ARCHIVED',
          message: `El plan de ConfioPagos para ${planSlug}/${currency} (${variante}) está archivado`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    if (!mapping.confioName) {
      throw new RequestException(
        {
          code: 'CONFIO_PLAN_NOT_CREATED',
          message:
            `El plan ${planSlug}/${currency} (${variante}) está mapeado pero todavía no fue ` +
            `creado en ConfioPagos: falta darlo de alta y guardar su resource name`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    return mapping.confioName
  }

  /** Todos los mapeos de un plan: una fila por moneda y variante de prueba. */
  async findMappings(planSlug: string): Promise<ConfioSubscriptionPlan[]> {
    return this.planReadRepo.find({
      where: { planSlug },
      // `withTrial` entra en el orden porque desde que hay dos filas por moneda el
      // orden anterior dejó de ser total, y una lista que se reordena sola entre
      // llamadas es un dolor de cabeza para quien la lee o la compara.
      order: { currencyCode: 'ASC', withTrial: 'DESC' },
    })
  }
}
