import { ConfioBuyer } from './confio.types'
import { ConfioBuyerField, ConfioSubscriptionInputError } from './confio-subscription-error'

/**
 * The single normalizer of a ConfioPagos subscription buyer. Pure module (no Nest, no `fetch`, no
 * `process.env`) so it can be called and tested directly.
 *
 * It exists because `req.user` only carries `{id, isSuperAdmin, brand}`, while ConfioPagos requires
 * a buyer with `email`, an E.164 `phoneNumber` and a 3-64 char `firstName`/`lastName`. The contact
 * data comes from backend-auth (`email`, `name`, `phone`, `callingCode`). Nothing is padded silently:
 *
 * - **Phone**: strict E.164 as is, or composed with the user's `callingCode`. A country is never
 *   assumed: without a `callingCode` a local number is rejected. Unlike
 *   `ConfioProvider.normalizeColombianPhone`, used only by one-shot links, nothing here assumes
 *   Colombia.
 * - **Name**: first word is `firstName`, the rest is `lastName`. A single word is copied into
 *   `lastName`: Confio only requires 3-64 chars, and rejecting would lock out real single-name users.
 * - **Missing or unusable name is derived from the email** (`resolveNameParts`): `name` is nullable
 *   in backend-auth, and the buyer cannot fix their profile from checkout, so rejecting would block
 *   the charge. `ana.perez@x.com` becomes `ana perez`.
 * - **Email**: non-empty and containing `@`.
 *
 * Every rejection is a `ConfioSubscriptionInputError` with `code` and `field`, thrown before any
 * network call, saying what arrived and what was expected, instead of Confio's opaque 422. Callers
 * map it by `instanceof` + `code` + `field`, never by message text.
 *
 * Messages include the received phone, name or email (PII): return them to the user, never log them.
 */

/** Strict E.164: `+`, country code without a leading 0, 8 to 15 digits in total. */
const E164 = /^\+[1-9]\d{7,14}$/

/** Country code without `+`: 1 to 4 digits, no leading 0. */
const CALLING_CODE = /^[1-9]\d{0,3}$/

/** `firstName`/`lastName` de ConfioPagos: `minLength: 3`, `maxLength: 64`. */
const NAME_MIN = 3
const NAME_MAX = 64

/**
 * The backend-auth fields the buyer is built from. All optional on purpose: with
 * `strictNullChecks: false` the compiler never flags an `undefined`, so validation is the only net.
 */
export interface ConfioBuyerSource {
  email?: string
  name?: string
  phone?: string
  callingCode?: string
}

const reject = (field: ConfioBuyerField, detail: string): never => {
  throw new ConfioSubscriptionInputError('invalid_buyer', `buyer.${field}`, detail)
}

/**
 * Builds the `ConfioBuyer` from backend-auth data.
 *
 * Validates email, then name, then phone: a buyer with two problems always reports the same field,
 * and the name may be derived from the email. `buyer.lastName` is never a rejection field.
 */
export function buildConfioBuyer(source: ConfioBuyerSource): ConfioBuyer {
  const email = assertEmail(source?.email)
  const partes = splitName(source?.name)

  return {
    email,
    ...resolveNameParts(partes.firstName, partes.lastName, email),
    phoneNumber: toE164(source?.phone, source?.callingCode),
  }
}

/**
 * Edge validation for a buyer already split into fields, run right before a request leaves.
 * Shares the primitives of `buildConfioBuyer`, so any buyer gets the same E.164, 3-64 and
 * name-from-email rules.
 *
 * Calls `toE164` without `callingCode` on purpose: there is no country to add here, so a bare local
 * number is rejected rather than assumed Colombian. Unlike the name, a wrong phone blocks the charge
 * and cannot be deduced, while the name comes from the email and only shows on the receipt.
 */
export function assertConfioBuyer(buyer: ConfioBuyer): ConfioBuyer {
  const email = assertEmail(buyer?.email)

  return {
    email,
    ...resolveNameParts((buyer?.firstName || '').trim(), (buyer?.lastName || '').trim(), email),
    phoneNumber: toE164(buyer?.phoneNumber),
  }
}

/** Mirrors Confio, which only checks for a non-empty email with `@`. */
function assertEmail(raw?: string): string {
  const email = (raw || '').trim()
  if (!email || !email.includes('@')) {
    reject('email', `se esperaba un email con "@", llegó "${email}"`)
  }
  return email
}

/** Neither pads nor truncates: length is judged by `isNamePart`. */
function splitName(raw?: string): { firstName: string; lastName: string } {
  const name = (raw || '').trim().replace(/\s+/g, ' ')
  if (!name) return { firstName: '', lastName: '' }

  const parts = name.split(' ')
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] }

  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/** The only rule Confio applies to each name part: 3 to 64 chars. */
function isNamePart(value: string): boolean {
  return value.length >= NAME_MIN && value.length <= NAME_MAX
}

/**
 * The single `firstName`/`lastName` policy, shared by both entry points.
 *
 * - A usable `firstName` wins; `lastName` is kept if usable, otherwise copied from `firstName`.
 * - An unusable `firstName` (missing, too short or over 64) derives the whole name from the email,
 *   discarding even a valid `lastName`: a half-profile, half-email name reads as someone else's on
 *   a recurring receipt.
 * - If the email yields nothing usable either, it rejects. Over 64 is rejected, not truncated:
 *   truncating would be the silent padding this module forbids.
 */
function resolveNameParts(
  firstCandidate: string,
  lastCandidate: string,
  email: string,
): { firstName: string; lastName: string } {
  if (isNamePart(firstCandidate)) {
    return {
      firstName: firstCandidate,
      lastName: isNamePart(lastCandidate) ? lastCandidate : firstCandidate,
    }
  }

  const local = emailLocalPart(email)
  const desdeEmail = splitName(local)
  if (!isNamePart(desdeEmail.firstName)) {
    reject(
      'firstName',
      `ConfioPagos exige de ${NAME_MIN} a ${NAME_MAX} caracteres: el nombre ` +
        `("${firstCandidate}") no sirve y el email "${email}" tampoco aporta uno ("${local}")`,
    )
  }
  return {
    firstName: desdeEmail.firstName,
    lastName: isNamePart(desdeEmail.lastName) ? desdeEmail.lastName : desdeEmail.firstName,
  }
}

/**
 * Readable part of the email, used as a name when the profile has none. The `+tag` sub-address is
 * routing noise, not identity. Nothing else is cleaned or capitalized: that would invent a name.
 */
function emailLocalPart(email: string): string {
  return email
    .split('@')[0]
    .split('+')[0]
    .replace(/[._-]+/g, ' ')
}

/**
 * The service's only E.164 implementation. Without a valid `callingCode` a non-E.164 phone is
 * rejected: no default country is assumed.
 *
 * Digits that already start with the country code (plus 7 or more digits) are an international
 * number missing its `+`, so the code is not prepended again: `573001234567` would otherwise become
 * `+57573001234567`, which passes the regex and attaches a wrong contact to a monthly charge.
 */
function toE164(rawPhone?: string, rawCallingCode?: string): string {
  const phone = (rawPhone || '').trim().replace(/[\s().-]/g, '')
  if (E164.test(phone)) return phone

  const callingCode = (rawCallingCode || '').replace(/[+\s-]/g, '')
  if (!CALLING_CODE.test(callingCode)) {
    reject(
      'phoneNumber',
      `se esperaba E.164 (+<país><número>), llegó "${phone}" y el usuario no tiene ` +
        `un código de país usable ("${rawCallingCode || ''}"); no se asume ningún país por defecto`,
    )
  }

  const digits = phone.replace(/\D/g, '').replace(/^0+/, '')
  const alreadyPrefixed = digits.startsWith(callingCode) && digits.length - callingCode.length >= 7
  const composed = alreadyPrefixed ? `+${digits}` : `+${callingCode}${digits}`

  if (!E164.test(composed)) {
    reject(
      'phoneNumber',
      `se esperaba E.164 (+<país><número>), con el código ${callingCode} el teléfono ` +
        `"${phone}" compone "${composed}", que no lo cumple`,
    )
  }
  return composed
}
