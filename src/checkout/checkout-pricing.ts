import { HttpStatus } from '@nestjs/common'

import {
  ClientRolesService,
  PLAN_NOT_FOUND,
  PRICE_NOT_FOUND_FOR_COUNTRY,
  PriceResolutionErrorCode,
} from '../client/client-roles.service'
import {
  ClientPlatformService,
  BRAND_LOOKUP_UNAVAILABLE,
  BRAND_NOT_FOUND,
  BRAND_WITHOUT_COUNTRY,
  BrandCountryErrorCode,
} from '../client/client-platform.service'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { RequestException } from '../shared/exception/request.exception'
import type { CheckoutRequest } from './checkout.service'
import { normalizeIdempotencyKey } from './checkout-idempotency'

/**
 * `country` is populated only when the price came from the country catalog so
 * provider gating and tax calculation use the same country that set the price
 * (omitted for enterprise custom pricing, legacy renewal fallback, and non-plan purposes).
 */
export interface ResolvedPricing {
  amount: number
  currency: string
  country?: string
}

export interface CheckoutPricingDeps {
  enterprisePricing: Pick<EnterprisePricingService, 'getForBrand'>
  clientPlatform: Pick<ClientPlatformService, 'resolveBrandCountry'>
  clientRoles: Pick<ClientRolesService, 'getPlanPrice' | 'resolvePriceForCountry'>
  logger: { warn: (message: string) => void; error: (message: string) => void }
}

/** Prices a checkout: plan purchases from the catalog, every other purpose from the caller's amount. */
export async function resolveAmountAndCurrency(
  req: CheckoutRequest,
  deps: CheckoutPricingDeps,
): Promise<ResolvedPricing> {
  // Gate on purpose alone so a missing planSlug cannot fall through to the generic caller-priced branch.
  if (req.purpose === 'plan_purchase') {
    assertUsablePlanSlug(req.planSlug)

    // Caller-requested currency is used only for legacy renewal fallback and legacy enterprise renewal.
    const legacyCurrency = req.currency || 'COP'

    if (req.planSlug === 'enterprise') {
      const customPricing = await deps.enterprisePricing.getForBrand(req.brandId)
      if (customPricing) {
        // Initial sign-up uses the currency stored on the negotiated row so the caller cannot bypass it by sending another currency.
        if (!req.renewal) {
          return { amount: Number(customPricing.monthlyPrice), currency: customPricing.currency }
        }
        if (customPricing.currency === legacyCurrency) {
          return { amount: Number(customPricing.monthlyPrice), currency: legacyCurrency }
        }
      }
    }

    if (req.renewal) {
      return renewalPlanPrice(req, legacyCurrency, deps)
    }

    const resolved = await resolvePlanPricingByCountry(req.brandId, req.planSlug, deps)
    if (!resolved.ok) {
      // No global ExceptionFilter logs HttpExceptions here, so log catalog/roles failures before throwing.
      deps.logger.warn(
        `Alta rechazada: brand=${req.brandId} plan=${req.planSlug} ` +
          `country=${resolved.country || 'desconocido'} code=${resolved.code}`,
      )
      throw planPricingException(req.planSlug, resolved.code)
    }

    return { amount: resolved.amount, currency: resolved.currency, country: resolved.country }
  }

  if (!req.currency) {
    throw new RequestException({ code: 'MISSING_AMOUNT', message: 'Monto y moneda requeridos' })
  }

  if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) {
    throw new RequestException(
      { code: 'INVALID_AMOUNT', message: 'Amount must be a finite number greater than zero' },
      HttpStatus.BAD_REQUEST,
    )
  }

  return { amount: req.amount, currency: req.currency }
}

/** Resolves plan pricing in the caller-requested currency; used only as the renewal cron fallback. */
async function legacyPlanPrice(
  planSlug: string,
  currency: string,
  deps: CheckoutPricingDeps,
): Promise<ResolvedPricing> {
  const price = await deps.clientRoles.getPlanPrice(planSlug, currency)
  if (price === null) {
    throw new RequestException({
      code: 'INVALID_PLAN',
      message: `Plan '${planSlug}' no disponible en moneda '${currency}'`,
    })
  }
  return { amount: price, currency }
}

/**
 * Renewal pricing tries the country catalog first and falls back to `legacyPlanPrice`
 * on country/catalog lookup errors so a transient failure or a non-UUID `subscriptions.brandId`
 * does not turn an active subscription into `past_due`.
 */
async function renewalPlanPrice(
  req: CheckoutRequest,
  legacyCurrency: string,
  deps: CheckoutPricingDeps,
): Promise<ResolvedPricing> {
  if (isUsableBrandId(req.brandId)) {
    const resolved = await resolvePlanPricingByCountry(req.brandId.trim(), req.planSlug, deps)
    if (resolved.ok) {
      return { amount: resolved.amount, currency: resolved.currency, country: resolved.country }
    }
    deps.logger.error(
      `Renovación fuera del catálogo por país: brand=${req.brandId} plan=${req.planSlug} ` +
        `country=${resolved.country || 'desconocido'} code=${resolved.code} → precio legacy ${legacyCurrency}`,
    )
  } else {
    deps.logger.error(
      `Renovación con brandId no consultable: brand=${req.brandId} plan=${req.planSlug} ` +
        `→ precio legacy ${legacyCurrency}`,
    )
  }

  return legacyPlanPrice(req.planSlug, legacyCurrency, deps)
}

/**
 * Uses `resolveBrandCountry` rather than `getBrandCountry` so each failure mode maps to its own HTTP status.
 * The row returned by `resolvePriceForCountry` comes from `ClientRolesService`'s cache and must not be mutated.
 */
async function resolvePlanPricingByCountry(
  brandId: string,
  planSlug: string,
  deps: CheckoutPricingDeps,
): Promise<
  // Opposite-branch `?: never` fields let TypeScript narrow the union with `strictNullChecks: false`.
  | { ok: true; amount: number; currency: string; country: string; code?: never }
  | {
      ok: false
      code: BrandCountryErrorCode | PriceResolutionErrorCode
      country?: string
      amount?: never
      currency?: never
    }
> {
  const brand = await deps.clientPlatform.resolveBrandCountry(brandId)
  if (!brand.ok) return { ok: false, code: brand.code }

  const price = await deps.clientRoles.resolvePriceForCountry(planSlug, brand.country)
  if (!price.ok) return { ok: false, code: price.code, country: brand.country }

  // Reject null/missing or non-finite prices (`Number(null)` coerces to 0, which is valid only when explicitly 0.00).
  const raw = price.price.price
  const amount = Number(raw)
  const currency = String(price.price.currency || '').toUpperCase()
  const missing = raw === null || raw === undefined
  if (missing || !Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
    deps.logger.error(
      `Fila de precio inválida para plan=${planSlug} country=${brand.country}: ` +
        `price=${String(raw)} currency=${String(price.price.currency)}`,
    )
    return { ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY, country: brand.country }
  }

  return { ok: true, amount, currency, country: brand.country }
}

/**
 * Returns a shallow copy with `brandId` normalized; UUID format is enforced only on
 * initial `plan_purchase` so renewals of existing subscriptions with non-UUID IDs do not fail.
 */
export function normalizeRequest(req: CheckoutRequest): CheckoutRequest {
  const brandId =
    req.purpose === 'plan_purchase' && !req.renewal
      ? assertUsableBrandId(req.brandId)
      : typeof req.brandId === 'string'
        ? req.brandId.trim()
        : req.brandId

  if (
    (req.purpose !== 'token_package' && req.packageId !== undefined) ||
    (req.purpose !== 'token_amount' && req.tokens !== undefined)
  ) {
    throw new RequestException(
      {
        code: 'CONFLICTING_TOKEN_FIELDS',
        message: 'packageId is only allowed for token_package and tokens only for token_amount',
      },
      HttpStatus.BAD_REQUEST,
    )
  }

  const idempotencyKey =
    req.idempotencyKey === undefined ? undefined : normalizeIdempotencyKey(req.idempotencyKey)

  if (req.purpose === 'token_amount' && !idempotencyKey) {
    throw new RequestException(
      {
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key is required for token_amount checkouts',
      },
      HttpStatus.BAD_REQUEST,
    )
  }

  if (req.idempotencyKey === undefined) {
    return { ...req, brandId }
  }

  return { ...req, brandId, idempotencyKey }
}

const BRAND_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUsableBrandId(brandId: string): boolean {
  return typeof brandId === 'string' && BRAND_ID_RE.test(brandId.trim())
}

/**
 * Rejects malformed `brandId` values with 400 before calling `backend-platform`, which would
 * otherwise return 400/404 and be misclassified as 503 `BRAND_LOOKUP_UNAVAILABLE`.
 */
function assertUsableBrandId(brandId: string): string {
  const normalized = typeof brandId === 'string' ? brandId.trim() : ''
  if (!isUsableBrandId(normalized)) {
    throw new RequestException(
      { code: 'INVALID_BRAND_ID', message: 'brandId requerido y debe ser un UUID' },
      HttpStatus.BAD_REQUEST,
    )
  }
  return normalized
}

/**
 * Restricts `planSlug` to safe identifier characters to prevent log injection (CWE-117) and path
 * traversal in `assignPlanToBrand`; `typeof` guards against `RegExp.test(undefined)` coercing to `"undefined"`.
 */
function assertUsablePlanSlug(planSlug: string) {
  if (typeof planSlug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(planSlug)) {
    throw new RequestException(
      { code: 'INVALID_PLAN_SLUG', message: 'planSlug inválido' },
      HttpStatus.BAD_REQUEST,
    )
  }
}

/**
 * `PLAN_NOT_FOUND` maps to 503 rather than 404 because `getPlanRows()` returns an empty map
 * when `backend-roles` is unreachable with a cold cache.
 */
function planPricingException(
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
      // Omit the country from the error message so the endpoint cannot be used to probe a brand's country.
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
