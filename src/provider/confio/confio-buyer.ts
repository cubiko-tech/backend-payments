import { ConfioBuyer } from './confio.types'
import { ConfioSubscriptionInputError } from './confio-subscription-error'

/**
 * Normalizador ÚNICO del comprador de una suscripción de ConfioPagos.
 *
 * Módulo PURO (sin Nest, sin `fetch`, sin `process.env`), mismo molde que
 * `confio-webhook-signature.ts`: se lo llama directo y se lo testea directo.
 *
 * Existe porque el guard sólo pone `{id, isSuperAdmin, brand}` en `req.user`
 * (`src/shared/auth/api-auth.guard.ts:42`), mientras que ConfioPagos exige un
 * comprador con `email`, `phoneNumber` E.164 y `firstName`/`lastName` de 3 a 64
 * caracteres. Los datos salen de `GET $SERVICE_AUTH/user/{id}` —`email`, `name`,
 * `phone`, `callingCode`— y acá se convierten en un `ConfioBuyer`.
 *
 * Reglas, todas verificables y sin ningún relleno silencioso:
 *
 * - **Teléfono**: E.164 estricto tal cual, o compuesto con el `callingCode` del
 *   usuario. **Nunca se inventa un país por defecto**: sin `callingCode` un
 *   número local se RECHAZA. Queda PROHIBIDO el fallback de
 *   `ConfioProvider.normalizeColombianPhone` al `+573215786325` de la
 *   documentación: en un link one-shot es cosmético, pegado a un cobro que se
 *   repite todos los meses es un contacto falso permanente.
 * - **Nombre**: la primera palabra es `firstName` y el resto, unido por
 *   espacios, es `lastName`. **Con una sola palabra se REPLICA en `lastName`**:
 *   Confío sólo exige 3–64 caracteres, no un apellido real, y rechazar dejaría
 *   afuera a usuarios legítimos registrados con un solo nombre.
 * - **Email**: no vacío y con `@`.
 *
 * Todo rechazo es un `ConfioSubscriptionInputError` con `code` y `field`, ANTES
 * de tocar la red, y dice qué llegó y qué se esperaba — el punto es reemplazar
 * el 422 opaco de Confío por algo accionable. Se mapea por `instanceof` +
 * `code` + `field`, NUNCA por el texto.
 *
 * ⚠️ Los mensajes incluyen el teléfono/nombre/email que llegó, o sea PII: son
 * para devolverle al propio usuario, no para loguear.
 */

/** E.164 estricto: `+`, país sin 0 inicial, y de 8 a 15 dígitos en total. */
const E164 = /^\+[1-9]\d{7,14}$/

/** Código de país sin `+`: de 1 a 4 dígitos y sin 0 inicial. */
const CALLING_CODE = /^[1-9]\d{0,3}$/

/** `firstName`/`lastName` de ConfioPagos: `minLength: 3`, `maxLength: 64`. */
const NAME_MIN = 3
const NAME_MAX = 64

/**
 * Los cuatro campos que devuelve backend-auth y que alimentan al comprador.
 * Todos opcionales a propósito: el tsconfig del servicio tiene
 * `strictNullChecks: false`, así que el compilador no avisa de un `undefined` —
 * la validación de abajo es la única red.
 */
export interface ConfioBuyerSource {
  email?: string
  name?: string
  phone?: string
  callingCode?: string
}

/**
 * Búsqueda del usuario, inyectada como función para que este módulo no se acople
 * a la red ni a Nest. La implementación de producción es
 * `ClientAuthService.getBuyerContact`.
 */
export type ConfioBuyerLookup = (userId: string) => Promise<ConfioBuyerSource>

const reject = (field: string, detail: string): never => {
  throw new ConfioSubscriptionInputError('invalid_buyer', `buyer.${field}`, detail)
}

/**
 * Arma el `ConfioBuyer` a partir de lo que devuelve backend-auth.
 *
 * Valida en orden email → firstName → lastName → phoneNumber, el mismo de la
 * guarda que vivía en `ConfioProvider`, para que un buyer con dos problemas
 * siga reportando el mismo campo que antes.
 */
export function buildConfioBuyer(source: ConfioBuyerSource): ConfioBuyer {
  const email = assertEmail(source?.email)
  const { firstName, lastName } = splitName(source?.name)

  return {
    email,
    firstName: assertNamePart(firstName, 'firstName'),
    lastName: assertNamePart(lastName, 'lastName'),
    phoneNumber: toE164(source?.phone, source?.callingCode),
  }
}

/**
 * Validación de BORDE para un comprador ya separado en campos: la que corre
 * `ConfioProvider.createSubscription` justo antes de salir a la red.
 *
 * Reusa las mismas primitivas que `buildConfioBuyer` — no hay una segunda
 * definición de E.164 ni del 3–64 en el servicio. Llama a `toE164` SIN
 * `callingCode` a propósito: en el borde no hay país que aportar, y un número
 * local suelto se rechaza en vez de que se le invente Colombia.
 */
export function assertConfioBuyer(buyer: ConfioBuyer): ConfioBuyer {
  return {
    email: assertEmail(buyer?.email),
    firstName: assertNamePart((buyer?.firstName || '').trim(), 'firstName'),
    lastName: assertNamePart((buyer?.lastName || '').trim(), 'lastName'),
    phoneNumber: toE164(buyer?.phoneNumber),
  }
}

/**
 * Compone el comprador para el usuario autenticado: `req.user` sólo trae el id,
 * así que los datos de contacto salen del `lookup`.
 *
 * El rechazo del `lookup` se **propaga tal cual**. Un fallo del canal (auth
 * caído, timeout) no puede terminar como `invalid_buyer`: eso convertiría una
 * caída de auth en «tus datos están mal». Regla de negocio de la épica 002 —
 * «un fallo del canal nunca se convierte en un hecho sobre el objeto».
 */
export async function resolveConfioBuyer(
  user: { id: string },
  lookup: ConfioBuyerLookup,
): Promise<ConfioBuyer> {
  return buildConfioBuyer(await lookup(user.id))
}

/** Email: no vacío y con `@`. Confío no valida más que eso. */
function assertEmail(raw?: string): string {
  const email = (raw || '').trim()
  if (!email || !email.includes('@')) {
    reject('email', `se esperaba un email con "@", llegó "${email}"`)
  }
  return email
}

/**
 * `trim` + colapso de espacios internos, y partición en dos.
 *
 * Con una sola palabra se replica en `lastName` (ver el comentario del módulo).
 * No se rellena ni se trunca nada: el largo lo juzga `assertNamePart`.
 */
function splitName(raw?: string): { firstName: string; lastName: string } {
  const name = (raw || '').trim().replace(/\s+/g, ' ')
  if (!name) return { firstName: '', lastName: '' }

  const parts = name.split(' ')
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] }

  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/** 3–64 caracteres, o rechazo diciendo cuánto llegó. Nunca rellena ni trunca. */
function assertNamePart(value: string, field: 'firstName' | 'lastName'): string {
  if (value.length < NAME_MIN || value.length > NAME_MAX) {
    reject(
      field,
      `ConfioPagos exige de ${NAME_MIN} a ${NAME_MAX} caracteres, llegó ${value.length} ("${value}")`,
    )
  }
  return value
}

/**
 * ÚNICA implementación de E.164 del servicio.
 *
 * 1. Limpia espacios, guiones, paréntesis y puntos, conservando el `+` inicial.
 * 2. Si ya cumple E.164 estricto, se devuelve tal cual.
 * 3. Si no, hace falta el `callingCode` del usuario. Sin él —o con algo que no
 *    es un código de país— se RECHAZA: no se asume ningún país por defecto.
 * 4. Del teléfono quedan sólo los dígitos, sin los ceros iniciales del prefijo
 *    troncal nacional.
 * 5. Si esos dígitos YA empiezan con el código de país y lo que sigue tiene 7 o
 *    más dígitos, el número ya venía internacionalizado sin `+` y NO se duplica
 *    el código. Componer a ciegas sobre `573001234567` daría `+57573001234567`,
 *    que pasa el regex y sería un contacto equivocado pegado a un cobro que se
 *    repite todos los meses.
 * 6. El resultado se valida contra E.164 estricto o se rechaza.
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
