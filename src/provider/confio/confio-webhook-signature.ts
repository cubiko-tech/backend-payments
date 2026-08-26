import { createHash, timingSafeEqual } from 'crypto'
import { ConfioWebhookPayload } from './confio.types'

/**
 * Motivo por el que un payload de webhook de ConfioPagos NO quedó firmado.
 *
 * Es contrato NUESTRO, no de Confío (lo de ellos vive en `confio.types.ts`):
 * quien llama decide qué hace con cada motivo —responder 401, ignorar el evento
 * o alertar— y este módulo se limita a nombrarlo.
 */
export type ConfioWebhookSignatureReason =
  | 'missing_key'
  | 'missing_signature'
  | 'missing_properties'
  | 'missing_checksum'
  | 'unexpected_properties'
  | 'event_mismatch'
  | 'missing_data_property'
  | 'invalid_data_type'
  | 'missing_timestamp'
  | 'checksum_mismatch'

/**
 * Veredicto discriminado por `signed`.
 *
 * ⚠️ `detail` sólo puede repetir lo que el propio emisor ya mandó —los nombres
 * de las propiedades declaradas y el `event`—. NUNCA puede llevar el digest
 * calculado ni la clave: el llamador loguea este campo, y publicar el checksum
 * esperado le regala la falsificación a quien esté probando payloads.
 *
 * ⚠️ Y ese eco pasa SIEMPRE por `echoForDetail`: como el llamador loguea, un
 * `event` con saltos de línea o secuencias ANSI forjaría líneas de log y un
 * `signature.properties` largo inflaría cada rechazo. `detail` es para triage,
 * no para reproducir el payload.
 */
export type ConfioWebhookSignatureVerdict =
  | { signed: true }
  | { signed: false; reason: ConfioWebhookSignatureReason; detail: string }

/**
 * Conjuntos de `signature.properties` admitidos, por evento.
 *
 * `signature.properties` LO DICTA EL PAYLOAD, así que recalcular ciegamente en
 * el orden que mande el emisor convierte la firma en algo que él controla a
 * medias (`CONFIOPAGOS_SUSCRIPCIONES.md` §Verificación, cuidado 1). Esta tabla
 * es la compuerta de los NOMBRES: acota qué claves de `data` pueden llegar a la
 * concatenación.
 *
 * ⚠️ Acota los nombres y NADA MÁS. El espacio de VALORES lo acota
 * `DATA_PROPERTY_TYPES`, y sin esa segunda compuerta la firma es falsificable
 * aunque el conjunto declarado sea el correcto: el digest concatena sin
 * separador, así que la frontera entre dos campos vecinos se puede mover.
 *
 * ⚠️ La variante fallida de 6 propiedades (sin `reason` declarado) es el fixture
 * VIVO `confio-webhook.spec.ts:47`. Omitirla silencia entera la rama de mora:
 * todo cobro fallido daría `unexpected_properties`.
 *
 * ⚠️ El conjunto `['name','status']` de `subscription.subscriptionStatusChanged`
 * está INFERIDO de nuestro propio fixture `confio-webhook.spec.ts:63`, no del
 * contrato: `CONFIOPAGOS_SUSCRIPCIONES.md` sólo publica el payload de cobro. Si
 * Confío declarara además `updateTime`, se rechazaría TODO cambio de estado.
 * Confirmar contra tráfico real cuando el webhook esté dado de alta.
 *
 * ⚠️ `payment.statusChanged` / `paymentAttempt.statusChanged` (link one-shot)
 * llegan hoy SIN objeto `signature` —fixture legacy `confio-webhook.spec.ts:129`—
 * y por eso este módulo les devuelve `missing_signature`. Qué hacer con ese
 * tráfico vivo es decisión del cableado, no de este módulo.
 */
const EXPECTED_PROPERTY_SETS: { event: string; properties: string[] }[] = [
  {
    event: 'subscription.billingStatusChanged',
    properties: ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment'],
  },
  {
    event: 'subscription.billingStatusChanged',
    properties: [
      'name',
      'cycleNumber',
      'amountCents',
      'currencyCode',
      'status',
      'failedCount',
      'reason',
    ],
  },
  {
    event: 'subscription.billingStatusChanged',
    properties: ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'failedCount'],
  },
  {
    event: 'subscription.subscriptionStatusChanged',
    properties: ['name', 'status'],
  },
]

/**
 * Tipo del contrato para cada valor que entra a la concatenación.
 *
 * Es la SEGUNDA compuerta, y es la que sostiene la firma: el digest concatena
 * `String(data[prop])` sin separador, así que mover un dígito de un campo al
 * vecino deja el MISMO string firmado. Un cobro legítimo recapturado con
 * `cycleNumber: 35` + `amountCents: '000000'` —o con `amountCents: 500000` +
 * `currencyCode: '0COP'`— produce un checksum IDÉNTICO al original: el conjunto
 * declarado calza, el `event` calza, todas las propiedades están presentes. El
 * ciclo 3 pasa a ser ciclo 35, `buildConfioWebhookEventId` acuña otra clave de
 * idempotencia y el mismo cobro se reprocesa por un importe elegido por quien
 * reenvía. Validar el tipo mata el corrimiento sin tocar la receta del digest:
 * un payload legítimo firma exactamente igual que antes.
 *
 * ⚠️ `reason` admite `null` A PROPÓSITO —regla (2) del digest—: rechazarlo haría
 * 401 en bucle sobre TODOS los cobros fallidos.
 *
 * ⚠️ Residual conocido y ACOTADO: `status` y `payment` son dos strings libres
 * adyacentes, así que esa frontera sigue siendo movible. El corrimiento sólo
 * puede ALARGAR `status` con un prefijo de `payment` (`'SUCCEEDED'` seguiría
 * siendo prefijo del valor forjado), nunca convertirlo en otro estado del
 * contrato —ninguno es prefijo de otro— y el despacho de `webhook.service.ts`
 * compara el estado COMPLETO. No se acota `status` con un regex a propósito: un
 * estado nuevo de Confío haría 401 en bucle, que es peor.
 */
const DATA_PROPERTY_TYPES: Record<string, (value: unknown) => boolean> = {
  name: (value) => typeof value === 'string',
  payment: (value) => typeof value === 'string',
  status: (value) => typeof value === 'string',
  currencyCode: (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value),
  cycleNumber: (value) => typeof value === 'number' && Number.isFinite(value),
  amountCents: (value) => typeof value === 'number' && Number.isFinite(value),
  failedCount: (value) => typeof value === 'number' && Number.isFinite(value),
  reason: (value) => value === null || typeof value === 'string',
}

/** Tope de caracteres por cada eco del emisor dentro de `detail`. */
const DETAIL_ECHO_MAX = 120

/**
 * Normaliza un valor QUE VIENE DEL EMISOR antes de que aparezca en `detail`.
 *
 * El llamador loguea `detail`: un `event` con `\n` o con secuencias ANSI forja
 * líneas de log, y un `signature.properties` de cientos de entradas infla cada
 * rechazo (hoy sólo lo acota el límite del body-parser). Se reemplazan los
 * caracteres de control por espacio y se trunca.
 */
function echoForDetail(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value)
  const clean = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')

  return clean.length > DETAIL_ECHO_MAX ? `${clean.slice(0, DETAIL_ECHO_MAX)}…` : clean
}

/** Clave ordenada de cada variante, calculada una sola vez al cargar el módulo. */
const EXPECTED_SORTED_KEYS = EXPECTED_PROPERTY_SETS.map((variant) => [...variant.properties].sort())

/**
 * Comparación en tiempo constante blindada contra entradas no-string.
 *
 * El atajo por longitud filtra sólo la longitud, igual que el vecino
 * `ConfioProvider.validateWebhookSignature`. El guard de `typeof` va de más
 * sobre la compuerta `missing_checksum`: así una entrada crafteada nunca puede
 * tirar un TypeError dentro de `Buffer.from`.
 *
 * Queda SIN exportar a propósito: `cablear-firma-en-el-webhook-confio` va a
 * necesitar la misma primitiva para el bearer y ahí sí conviene extraerla; hasta
 * ese segundo llamador real, YAGNI.
 */
function timingSafeEqualStrings(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false

  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}

/**
 * Dice si un payload ya parseado de webhook de ConfioPagos viene firmado con
 * `webhookKey`.
 *
 * Receta del contrato (`CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks/Verificación):
 *
 *     SHA256(data[prop1] + data[prop2] + … + timestamp + WEBHOOK_KEY)
 *
 * Módulo PURO: no lee `process.env`, no loguea y no depende de Nest. Las
 * comprobaciones van fail-closed y de la más barata a la más cara, de modo que
 * un payload malformado tiene veredicto propio ANTES de cualquier hash.
 *
 * ⚠️ ALCANCE: esto dice si el payload está FIRMADO, no si es FRESCO. No hay
 * ventana de validez sobre `timestamp`, así que una retransmisión textual de un
 * payload legítimo —el mismo body, byte a byte— firma para siempre. Quien
 * cablee este módulo NO puede quedarse sólo con el veredicto: la defensa contra
 * la reentrega es la clave de idempotencia de `buildConfioWebhookEventId`
 * (`confio-webhook.ts`), y sin ella este módulo no la aporta.
 */
export function verifyConfioWebhookSignature(
  payload: ConfioWebhookPayload,
  webhookKey: string,
): ConfioWebhookSignatureVerdict {
  if (typeof webhookKey !== 'string' || webhookKey.length === 0) {
    return { signed: false, reason: 'missing_key', detail: 'WEBHOOK_KEY vacía o no configurada' }
  }

  // Optional chaining en todo el camino —mismo idiom que
  // `buildConfioWebhookEventId`— para que un payload `null` no pueda tirar.
  const signature = payload?.signature
  if (!signature) {
    return {
      signed: false,
      reason: 'missing_signature',
      detail: 'el payload no trae objeto signature',
    }
  }

  const properties = signature.properties
  if (!properties || !Array.isArray(properties)) {
    return {
      signed: false,
      reason: 'missing_properties',
      detail: 'signature.properties ausente o no es un array',
    }
  }

  const checksum = signature.checksum
  if (typeof checksum !== 'string' || checksum.length === 0) {
    return {
      signed: false,
      reason: 'missing_checksum',
      detail: 'signature.checksum ausente, vacío o no es un string',
    }
  }

  const declared = echoForDetail(properties.join(', '))

  // Compuerta del conjunto declarado. Se compara una COPIA ordenada, no un Set:
  // así se rechazan de arriba los duplicados (`['name','name']`) y las entradas
  // no-string. Lo que se valida es el CONJUNTO; el ORDEN DECLARADO sigue
  // mandando el digest, así que una permutación pasa esta compuerta y muere más
  // abajo en `checksum_mismatch` — semántica documentada, no accidente.
  const declaredSorted = [...properties].sort()
  const matchIndex = EXPECTED_SORTED_KEYS.findIndex(
    (expected) =>
      expected.length === declaredSorted.length &&
      expected.every((prop, index) => prop === declaredSorted[index]),
  )
  if (matchIndex === -1) {
    return {
      signed: false,
      reason: 'unexpected_properties',
      detail: `conjunto declarado no esperado: [${declared}]`,
    }
  }

  const variant = EXPECTED_PROPERTY_SETS[matchIndex]

  // El `event` NO entra al checksum. Sin esta comprobación, un payload legítimo
  // recapturado y reenviado con el `event` cambiado pasa la firma intacto, acuña
  // otra clave de idempotencia en `buildConfioWebhookEventId` y se despacha por
  // otra rama de `webhook.service.ts` (el switch por `data.status`).
  if (payload.event !== variant.event) {
    return {
      signed: false,
      reason: 'event_mismatch',
      detail: `event "${echoForDetail(payload.event)}" no corresponde al conjunto [${declared}]`,
    }
  }

  // `|| {}` para que un `data: null` o `data: 'x'` no rompa el `call` de abajo.
  const data: Record<string, any> = (payload?.data as Record<string, any>) || {}

  // Se verifica CADA propiedad declarada, no sólo las que `data` traiga: si
  // faltara una, la concatenación firmaría el literal 'undefined' y una firma
  // válida sobre datos incompletos es peor que un rechazo.
  // `Object.prototype.hasOwnProperty.call` es deliberado sobre
  // `data.hasOwnProperty(...)`: un payload con su propio campo `hasOwnProperty`
  // haría estallar la llamada directa.
  // El chequeo de TIPO va en el mismo recorrido y por el mismo motivo: sin él la
  // presencia no alcanza, porque el digest no separa los campos (ver
  // `DATA_PROPERTY_TYPES`). Si faltara el validador de una propiedad de la tabla
  // de conjuntos, se rechaza: fail-closed también ante un olvido nuestro.
  for (const prop of variant.properties) {
    if (!Object.prototype.hasOwnProperty.call(data, prop)) {
      return {
        signed: false,
        reason: 'missing_data_property',
        detail: `data no trae la propiedad declarada "${prop}"`,
      }
    }

    const hasExpectedType = DATA_PROPERTY_TYPES[prop]
    if (!hasExpectedType || !hasExpectedType(data[prop])) {
      return {
        signed: false,
        reason: 'invalid_data_type',
        detail: `data.${prop} no tiene el tipo del contrato`,
      }
    }
  }

  // Misma regla que el bucle de arriba, ahora sobre el envelope: un `timestamp`
  // ausente firmaría el literal 'undefined' y saldría como `checksum_mismatch`,
  // un motivo que MIENTE en el triage si Confío cambiara el envelope. Va acá y
  // no arriba para no cambiar el orden de veredictos de un payload malformado.
  const timestamp = payload.timestamp
  const timestampIsScalar =
    (typeof timestamp === 'number' && Number.isFinite(timestamp)) ||
    (typeof timestamp === 'string' && timestamp.length > 0)
  if (!timestampIsScalar) {
    return {
      signed: false,
      reason: 'missing_timestamp',
      detail: 'timestamp ausente o no es un escalar del envelope',
    }
  }

  // Digest: valores en el ORDEN DECLARADO, sin separador, después el timestamp
  // y al final la clave.
  //   (1) SHA-256 SIMPLE, no HMAC — `createHmac` es el reflejo equivocado.
  //   (2) `String(null)` da 'null' a propósito, la misma regla que los números
  //       (`3` → `'3'`): un `reason: null` legítimo en un cobro fallido, si se
  //       rechazara, haría 401 en bucle sobre TODOS los cobros fallidos.
  //   (3) Sin `trim()` en ningún lado: ni sobre los valores de `data` ni sobre
  //       el checksum recibido. Hexadecimal en MAYÚSCULA y sin prefijo.
  let concatenated = ''
  for (const prop of properties) {
    concatenated += String(data[prop])
  }
  concatenated += String(timestamp)
  concatenated += webhookKey

  const expectedChecksum = createHash('sha256')
    .update(concatenated, 'utf8')
    .digest('hex')
    .toUpperCase()

  if (!timingSafeEqualStrings(checksum, expectedChecksum)) {
    return {
      signed: false,
      reason: 'checksum_mismatch',
      detail: `checksum inválido para event "${echoForDetail(payload.event)}" sobre [${declared}]`,
    }
  }

  return { signed: true }
}
