import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  BRAND_LOOKUP_UNAVAILABLE,
  BRAND_NOT_FOUND,
  BRAND_WITHOUT_COUNTRY,
  BrandCountryErrorCode,
  ClientPlatformService,
} from '../client/client-platform.service'
import {
  ClientRolesService,
  PLAN_NOT_FOUND,
  PRICE_NOT_FOUND_FOR_COUNTRY,
  PriceResolutionErrorCode,
} from '../client/client-roles.service'
import {
  BuyerContactErrorCode,
  ClientAuthService,
  USER_LOOKUP_UNAVAILABLE,
} from '../client/client-auth.service'
import { ConfioPlanService } from '../provider/confio/confio-plan.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
import { buildConfioBuyer } from '../provider/confio/confio-buyer'
import { CreateConfioSubscriptionParams, ConfioSubscriptionResult } from '../provider/confio/confio.types'
import { RequestException } from '../shared/exception/request.exception'

/**
 * Preparación del alta de una suscripción de trial contra ConfioPagos.
 *
 * Adaptador entre el alta (`SubscriptionService.startTrial`) y la pasarela: junta
 * lo que ConfioPagos necesita —el resource name del plan y el comprador
 * completo— y traduce TODO fallo a un `RequestException` con código propio. El
 * corte es el mismo que el de `webhook/confio-subscription-webhook.service.ts`:
 * la conversación con la pasarela vive afuera del servicio de dominio, que se
 * queda con la fila y sus invariantes.
 *
 * Cadena de resolución, en este orden y sin atajos:
 *   país de la marca (platform) → fila de precio del plan para ese país (roles)
 *   → moneda de la fila → plan de ConfioPagos para (plan, moneda) → comprador
 *   (auth, normalizado por `confio-buyer.ts`) → `POST` del alta.
 *
 * ⚠️ El alta **no cobra**: devuelve `PENDING_ACCEPTANCE` más el `acceptanceUrl`,
 * el «único link inicial» del criterio 1 de la épica 002. Ese link es PORTADOR
 * (quien lo tenga registra una tarjeta contra la suscripción): se devuelve al
 * llamador y nunca se persiste ni se loguea.
 *
 * DUPLICACIÓN CONSCIENTE: `planPricingException` repite el mapeo de
 * `CheckoutService.planPricingException` (`checkout.service.ts:851`). Se prefiere
 * la duplicación anotada antes que abrir `checkout.service.ts`, que esta tarea no
 * nombra; la extracción —resolución + mapeo juntos, no sólo el `switch`— queda
 * anotada en el INBOX.
 */
@Injectable()
export class ConfioTrialService {
  private readonly logger = new Logger(ConfioTrialService.name)

  constructor(
    private readonly clientPlatform: ClientPlatformService,
    private readonly clientRoles: ClientRolesService,
    private readonly clientAuth: ClientAuthService,
    private readonly confioPlans: ConfioPlanService,
    private readonly confio: ConfioProvider,
  ) {}

  /**
   * Crea la suscripción en ConfioPagos para un alta de trial.
   *
   * `correlationId` es OPCIONAL a propósito y sólo lo manda quien tiene un id
   * estable entre reintentos (el alta lo pasa cuando reusa una fila muerta). Para
   * una marca sin fila NO se pre-genera un uuid: cada reintento dejaría del lado
   * de ConfioPagos un huérfano con un correlationId distinto que ya no
   * correlaciona con nada nuestro. La resolución del webhook no depende de él —
   * busca primero por `providerSubscriptionId = data.name`
   * (`webhook/confio-subscription-webhook.service.ts:158`) y el `name` SIEMPRE se
   * persiste.
   */
  async createForTrial(input: {
    brandId: string
    userId: string
    planSlug: string
    correlationId?: string
  }): Promise<ConfioSubscriptionResult> {
    const { brandId, userId, planSlug, correlationId } = input

    // Se usa `resolveBrandCountry` y no el envoltorio `getBrandCountry` porque éste
    // colapsa los tres modos de fallo en `null` y acá cada uno mapea a un HTTP
    // distinto. Mismo criterio que el checkout.
    const brand = await this.clientPlatform.resolveBrandCountry(brandId)
    if (!brand.ok) throw this.planPricingException(planSlug, brand.code)

    const price = await this.clientRoles.resolvePriceForCountry(planSlug, brand.country)
    if (!price.ok) throw this.planPricingException(planSlug, price.code)

    // La moneda es un dato DERIVADO de la fila de precio, nunca un parámetro del
    // llamador: el plan de ConfioPagos se elige por (plan, moneda) y con la moneda
    // equivocada se cobraría 19.900 COP a una marca que paga en dólares.
    const currency = String(price.price.currency || '').toUpperCase()
    // Rechaza con su propio código (CONFIO_PLAN_NOT_MAPPED / _NOT_CREATED /
    // _ARCHIVED): se propaga tal cual, ya viene con status.
    const planName = await this.confioPlans.resolveConfioPlanName(planSlug, currency)

    const contact = await this.clientAuth.resolveBuyerContact(userId)
    if (!contact.ok) throw this.buyerContactException(contact.code)

    return this.callConfio(() => {
      // `buildConfioBuyer` rechaza con `ConfioSubscriptionInputError` ANTES de
      // tocar la red; por eso va DENTRO del mismo envoltorio que la llamada.
      const buyer = buildConfioBuyer(contact.contact)
      const params: CreateConfioSubscriptionParams = { planName, buyer }
      // Se agrega la CLAVE sólo si hay valor: `correlationId: undefined` viajaría
      // en el body como un campo vacío y el provider lo distingue con `!== undefined`.
      if (correlationId !== undefined) params.correlationId = correlationId
      return this.confio.createSubscription(params)
    })
  }

  /**
   * Re-pide el link de aceptación por el camino autenticado, a partir del `name`
   * que quedó guardado en nuestra fila.
   *
   * Es el motivo por el que el `acceptanceUrl` no se persiste: el link se vuelve a
   * pedir cuando hace falta en vez de guardarse en una columna que después hay que
   * proteger. Sólo viene mientras el estado sea `PENDING_ACCEPTANCE`.
   */
  async fetchAcceptance(name: string): Promise<{
    acceptanceUrl?: string
    status: string
    acceptanceExpireTime?: Date
  }> {
    const sub = await this.callConfio(() => this.confio.getSubscription(name))

    return {
      acceptanceUrl: sub.acceptanceUrl,
      status: sub.status,
      acceptanceExpireTime: sub.acceptanceExpireTime,
    }
  }

  /**
   * Único envoltorio de la conversación con la pasarela.
   *
   * Dos salidas y ninguna tercera:
   * - `ConfioSubscriptionInputError` (rechazo LOCAL, la petición nunca salió) →
   *   lo desglosa `inputErrorException` por `code`, nunca por el texto del
   *   mensaje, que es el contrato declarado en `confio-subscription-error.ts`.
   * - cualquier otro fallo (5xx, timeout, red) → 503 sin reexponer el cuerpo de
   *   ConfioPagos: un fallo del canal no es un hecho sobre el objeto.
   *
   * ⚠️ El `detail` de `ConfioSubscriptionInputError` incluye el email, el teléfono
   * o el nombre que llegó, o sea PII: no vuelve al cliente NI va al log. Devolverlo
   * permitiría enumerar contactos con un token válido — y ojo, el `userId` de este
   * camino viene del BODY, no de `req.user`.
   */
  private async callConfio<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ConfioSubscriptionInputError) {
        this.logger.warn(`Alta de ConfioPagos rechazada localmente [${error.code}] en ${error.field}`)
        throw this.inputErrorException(error)
      }

      this.logger.error(`ConfioPagos no pudo procesar la suscripción: ${error?.message}`)
      throw new RequestException(
        {
          code: 'CONFIO_SUBSCRIPTION_UNAVAILABLE',
          message: 'No se pudo crear la suscripción en ConfioPagos, reintentá en unos minutos',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
  }

  /**
   * Desglosa los CUATRO códigos de rechazo local en sus dos naturalezas, que no
   * se colapsan — misma regla de negocio de la épica 002 que aplica
   * `buyerContactException`: «un fallo del canal nunca se convierte en un hecho
   * sobre el objeto», y su recíproca, un error NUESTRO no se le factura al
   * cliente.
   *
   * - `invalid_buyer` / `missing_buyer_or_plan` hablan de lo que mandó el
   *   llamador → 422 `INVALID_BUYER` con el `field` para que sepa qué corregir.
   * - `plan_store_mismatch` (el `planName` del catálogo no es del
   *   `CONFIO_STORE_ID` configurado, `confio.provider.ts:364`) e
   *   `invalid_subscription_name` (un `name` malformado que persistimos
   *   nosotros, alcanzable por `fetchAcceptance`) son CONFIGURACIÓN nuestra:
   *   el comprador no tiene nada que arreglar y reintentar con otros datos no
   *   cambia nada → 503 con su propio código, que es el que hay que buscar en
   *   el log de despliegue.
   *
   * El `detail` NO viaja en ninguna de las dos ramas: lleva PII en la primera y
   * el store esperado en la segunda.
   */
  private inputErrorException(error: ConfioSubscriptionInputError): RequestException {
    switch (error.code) {
      case 'plan_store_mismatch':
        return new RequestException(
          {
            code: 'CONFIO_PLAN_STORE_MISMATCH',
            message: 'La integración con ConfioPagos está mal configurada, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case 'invalid_subscription_name':
        return new RequestException(
          {
            code: 'CONFIO_SUBSCRIPTION_NAME_INVALID',
            message: 'La suscripción guardada no es consultable en ConfioPagos, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case 'invalid_buyer':
      case 'missing_buyer_or_plan':
      default:
        return new RequestException(
          {
            code: 'INVALID_BUYER',
            message: 'Los datos del comprador no cumplen lo que exige ConfioPagos',
            field: error.field,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
    }
  }

  /**
   * Mapea el fallo de resolución de país/precio a su HTTP, con los MISMOS códigos
   * y status que `CheckoutService.planPricingException`.
   *
   * `PLAN_NOT_FOUND` responde 503 y NO 404 por la razón ya documentada allá:
   * `getPlanRows()` devuelve un Map VACÍO cuando backend-roles no contesta y no
   * hay caché, así que durante un outage de roles TODOS los planes darían
   * `PLAN_NOT_FOUND` y contestar "ese plan no existe" disfrazaría una caída de
   * backend como un error definitivo del cliente.
   */
  private planPricingException(
    planSlug: string,
    code: BrandCountryErrorCode | PriceResolutionErrorCode,
  ): RequestException {
    switch (code) {
      case BRAND_LOOKUP_UNAVAILABLE:
        return new RequestException(
          {
            code: BRAND_LOOKUP_UNAVAILABLE,
            message: 'No se pudo consultar el país de la marca, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case BRAND_NOT_FOUND:
        return new RequestException(
          { code: BRAND_NOT_FOUND, message: 'La marca no existe' },
          HttpStatus.NOT_FOUND,
        )
      case BRAND_WITHOUT_COUNTRY:
        return new RequestException(
          {
            code: BRAND_WITHOUT_COUNTRY,
            message: 'La marca no tiene país registrado: no se puede determinar el precio',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      case PRICE_NOT_FOUND_FOR_COUNTRY:
        // El país NO va en el mensaje: devolverlo convertiría al alta en un lector
        // del país de cualquier marca. Queda en el `logger.warn` del rechazo.
        return new RequestException(
          {
            code: PRICE_NOT_FOUND_FOR_COUNTRY,
            message: `El plan '${planSlug}' no tiene precio para el país de la marca`,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      case PLAN_NOT_FOUND:
      default:
        return new RequestException(
          { code: PLAN_NOT_FOUND, message: `Catálogo de planes no disponible para '${planSlug}'` },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
    }
  }

  /**
   * Los dos modos de fallo del contacto del comprador NO se colapsan: auth caído
   * es transitorio (503) y un usuario inexistente es definitivo (422). Regla de
   * negocio de la épica 002: «un fallo del canal nunca se convierte en un hecho
   * sobre el objeto».
   */
  private buyerContactException(code: BuyerContactErrorCode): RequestException {
    if (code === USER_LOOKUP_UNAVAILABLE) {
      return new RequestException(
        {
          code: USER_LOOKUP_UNAVAILABLE,
          message: 'No se pudo consultar el contacto del usuario, reintentá en unos minutos',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    return new RequestException(
      { code, message: 'El usuario que inicia el alta no existe' },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
}
