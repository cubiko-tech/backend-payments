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
  FALLBACK_CURRENCY,
  PLAN_NOT_FOUND,
  PRICE_NOT_FOUND_FOR_COUNTRY,
  PriceResolutionErrorCode,
} from '../client/client-roles.service'
import {
  BuyerContactErrorCode,
  ClientAuthService,
  USER_LOOKUP_UNAVAILABLE,
} from '../client/client-auth.service'
import { ConfioPlanService, CONFIO_PLAN_ARCHIVED } from '../provider/confio/confio-plan.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
import { buildConfioBuyer } from '../provider/confio/confio-buyer'
import {
  CreateConfioSubscriptionParams,
  ConfioSubscriptionResult,
} from '../provider/confio/confio.types'
import { RequestException } from '../shared/exception/request.exception'
import { invalidBuyerException } from './invalid-buyer-exception'

/**
 * Prepares a ConfioPagos subscription signup (trial or paid) on behalf of `SubscriptionService`.
 *
 * Gathers what the gateway needs (plan resource name and full buyer) and turns EVERY failure into a
 * `RequestException` with its own code, so the domain service keeps only the row and its invariants.
 *
 * Resolution order, no shortcuts:
 *   brand country (platform) -> plan price row for that country (roles) -> row currency
 *   -> ConfioPagos plan for (plan, currency) -> buyer (auth, normalized by `confio-buyer.ts`) -> `POST`.
 *
 * The signup does NOT charge: it returns `PENDING_ACCEPTANCE` plus `acceptanceUrl`. That link is a
 * bearer token (whoever holds it registers a card on the subscription): it is returned to the caller
 * and never persisted or logged.
 *
 * `planPricingException` duplicates the one in `checkout/checkout-pricing.ts`; change both together.
 */
/**
 * Reason sent when cancelling the PREVIOUS subscription on a new signup. ConfioPagos requires and
 * stores it, so whoever inspects that subscription there can tell why it ended without our logs.
 */
const MOTIVO_DE_REEMPLAZO = 'Reemplazada por un alta nueva de la misma marca en ROAX'

@Injectable()
export class ConfioTrialService {
  private readonly logger = new Logger(ConfioTrialService.name)

  /** The missing return URL warning is logged ONCE, not on every signup. */
  private avisoDeRetornoDado = false

  constructor(
    private readonly clientPlatform: ClientPlatformService,
    private readonly clientRoles: ClientRolesService,
    private readonly clientAuth: ClientAuthService,
    private readonly confioPlans: ConfioPlanService,
    private readonly confio: ConfioProvider,
    private readonly confioCancellation: ConfioCancellationService,
  ) {}

  /**
   * Where the buyer returns after registering a payment method.
   *
   * Comes from its own variable and NEVER from `DOMAIN`: the subscription screen lives in the
   * Dropi front, a different domain per environment, so deriving it from ours would send the
   * buyer nowhere. Unset, it returns `undefined` and the key is not sent: the buyer stays on the
   * ConfioPagos page, a worse experience but never a wrong destination.
   */
  private get redirectUri(): string | undefined {
    const url = (process.env.SUBSCRIPTION_RETURN_URL || '').trim()
    if (url) return url

    if (!this.avisoDeRetornoDado) {
      this.avisoDeRetornoDado = true
      this.logger.warn(
        'SUBSCRIPTION_RETURN_URL no configurada: el alta no manda `redirectUri` y el comprador ' +
          'se queda en la página de ConfioPagos después de aceptar',
      )
    }
    return undefined
  }

  /**
   * Creates the ConfioPagos subscription for both trial and paid signups; `conPrueba` tells them
   * apart. The gateway request has no trial field: the trial is frozen in the PLAN it is created
   * against, so only the chosen plan differs.
   *
   * `correlationId` is optional on purpose: pass it only when it is stable across retries. A fresh
   * uuid per attempt would leave ConfioPagos orphans that correlate with nothing of ours. The
   * webhook resolves by `providerSubscriptionId = data.name`, which is always persisted.
   */
  async createForTrial(input: {
    brandId: string
    userId: string
    planSlug: string
    correlationId?: string
    /**
     * Resource name of the ConfioPagos subscription this signup REPLACES when a row is reused.
     * It is cancelled before the new one is created.
     */
    reemplazaA?: string
    /**
     * Whether this signup gets the ConfioPagos trial. Required, no default: it picks the gateway
     * plan, so a default would silently give the trial back to a brand that already used it.
     */
    conPrueba: boolean
    /**
     * Phone ConfioPagos will CHARGE, when it is not the account one. Not contact data: the link is
     * authorized for this exact number, so a wrong one blocks payment. Absent means the account
     * phone. Validated by `buildConfioBuyer` (E.164), so a bad format never reaches the network.
     */
    telefonoDeCobro?: string
  }): Promise<ConfioSubscriptionResult & { currency: string }> {
    const { brandId, userId, planSlug, correlationId, reemplazaA, conPrueba, telefonoDeCobro } =
      input

    // Not `getBrandCountry`: it collapses the three failure modes into `null`, and each maps to a
    // different HTTP status here.
    const brand = await this.clientPlatform.resolveBrandCountry(brandId)
    if (!brand.ok) throw this.planPricingException(planSlug, brand.code)

    const price = await this.clientRoles.resolvePriceForCountry(planSlug, brand.country)
    if (!price.ok) throw this.planPricingException(planSlug, price.code)

    // Currency is DERIVED from the price row, never taken from the caller: the gateway plan is
    // picked by (plan, currency), and a wrong currency would charge COP to a brand paying in USD.
    const resuelto = await this.resolvePlanConCaidaAUsd(
      planSlug,
      String(price.price.currency || '').toUpperCase(),
      conPrueba,
    )
    const { planName, currency } = resuelto

    // `subscriptions` does not store the currency: this log is the only local record of which one
    // a signup was charged in.
    this.logger.log(
      `Alta de ${brandId} en ${planSlug}: moneda ${currency}, plan de ConfioPagos ${planName}`,
    )

    const contact = await this.clientAuth.resolveBuyerContact(userId)
    if (!contact.ok) throw this.buyerContactException(contact.code)

    // Through the wrapper so an unusable buyer is the 422, and before the cancel so it keeps the old
    // subscription; the charge phone replaces only the account phone.
    const buyer = await this.callConfio(() =>
      buildConfioBuyer(
        telefonoDeCobro ? { ...contact.contact, phone: telefonoDeCobro } : contact.contact,
      ),
    )

    // R27: money risk. ConfioPagos allows several live subscriptions per buyer, so an uncancelled
    // previous one keeps charging with no row of ours. Cancel last, after every lookup that can fail;
    // a failed cancel aborts the signup with zero writes. `/cancel` is idempotent.
    if (reemplazaA) {
      await this.confioCancellation.cancel(reemplazaA, MOTIVO_DE_REEMPLAZO)
      this.logger.log(`Suscripción anterior cancelada en ConfioPagos antes del alta de ${brandId}`)
    }

    const created = await this.callConfio(() => {
      const params: CreateConfioSubscriptionParams = { planName, buyer }
      // Set the KEY only when there is a value: the provider checks `!== undefined`, so an
      // undefined key would still travel as an empty field.
      if (correlationId !== undefined) params.correlationId = correlationId
      // Same rule for the return URL; applies to paid signups (`startPaid`) too.
      const redirectUri = this.redirectUri
      if (redirectUri !== undefined) params.redirectUri = redirectUri
      return this.confio.createSubscription(params)
    })
    return { ...created, currency }
  }

  /**
   * Fetches the acceptance link again from the stored `name`, which is why `acceptanceUrl` is
   * never persisted. It is only present while the status is `PENDING_ACCEPTANCE`.
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
   * The only wrapper around gateway calls, with exactly two outcomes:
   * - `ConfioSubscriptionInputError` (LOCAL rejection, nothing sent) -> `inputErrorException`,
   *   split by `code`, never by message text.
   * - any other failure (5xx, timeout, network) -> 503 without the gateway body: a channel failure
   *   is not a fact about the object.
   *
   * The error `detail` holds PII (email, phone, name): it never reaches the client or the log.
   * Returning it would let a valid token enumerate contacts, since `userId` here comes from the BODY.
   */
  private async callConfio<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ConfioSubscriptionInputError) {
        this.logger.warn(
          `Alta de ConfioPagos rechazada localmente [${error.code}] en ${error.field}`,
        )
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
   * Splits the four local rejection codes by whose fault it is; OUR errors are never blamed on
   * the client.
   * - `invalid_buyer` / `missing_buyer_or_plan`: caller input -> 422 `INVALID_BUYER` with `field`.
   * - `plan_store_mismatch` (catalog plan not in the configured `CONFIO_STORE_ID`) and
   *   `invalid_subscription_name` (a malformed `name` we stored): OUR configuration -> 503 with
   *   its own code, the one to search for in the deploy log.
   *
   * `detail` is never sent: it carries PII in the first branch and the expected store in the second.
   */
  private inputErrorException(error: ConfioSubscriptionInputError): RequestException {
    switch (error.code) {
      case 'plan_store_mismatch':
        return new RequestException(
          {
            code: 'CONFIO_PLAN_STORE_MISMATCH',
            message:
              'La integración con ConfioPagos está mal configurada, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case 'invalid_subscription_name':
        return new RequestException(
          {
            code: 'CONFIO_SUBSCRIPTION_NAME_INVALID',
            message:
              'La suscripción guardada no es consultable en ConfioPagos, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case 'invalid_buyer':
      case 'missing_buyer_or_plan':
      default:
        return invalidBuyerException(error.field)
    }
  }

  /**
   * The ConfioPagos plan for that currency, falling back to USD when the currency is switched off.
   *
   * Only `CONFIO_PLAN_ARCHIVED` triggers the fallback: archiving a mapping switches a currency off
   * reversibly. A missing mapping or an uncreated plan is a configuration gap, and charging another
   * currency would hide it. Returns the currency ACTUALLY used, which is the one to log.
   */
  private async resolvePlanConCaidaAUsd(
    planSlug: string,
    currency: string,
    conPrueba: boolean,
  ): Promise<{ planName: string; currency: string }> {
    try {
      // Throws with its own code and status (`CONFIO_PLAN_NOT_MAPPED`, `_NOT_CREATED`,
      // `_ARCHIVED`), propagated as is.
      const planName = await this.confioPlans.resolveConfioPlanName(planSlug, currency, conPrueba)
      return { planName, currency }
    } catch (error) {
      const apagada = error instanceof RequestException && error.code === CONFIO_PLAN_ARCHIVED
      if (!apagada || currency === FALLBACK_CURRENCY) throw error

      this.logger.warn(
        `Pasarela de ${planSlug}/${currency} apagada: el alta se cobra en ${FALLBACK_CURRENCY}`,
      )
      const planName = await this.confioPlans.resolveConfioPlanName(
        planSlug,
        FALLBACK_CURRENCY,
        conPrueba,
      )
      return { planName, currency: FALLBACK_CURRENCY }
    }
  }

  /**
   * Maps a country/price resolution failure to the SAME codes and statuses as
   * `planPricingException` in `checkout/checkout-pricing.ts`. `PLAN_NOT_FOUND` is 503, not 404: with roles down and
   * no cache every plan reads as missing, and a 404 would disguise an outage as a client error.
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
        // The country is NOT in the message: it would turn signup into a reader of any brand's
        // country.
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
   * Keeps the two buyer contact failures apart: auth down is transient (503), a missing user is
   * final (422). A channel failure never becomes a fact about the object.
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
