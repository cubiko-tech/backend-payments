import { verifyConfioWebhookSignature } from './confio-webhook-signature'
import { ConfioWebhookPayload } from './confio.types'

/**
 * Vectores armados A MANO: los checksums de abajo están precalculados fuera del
 * test y viajan como constantes literales. El test NUNCA llama a `createHash` ni
 * a la implementación para armar lo que después compara — si lo hiciera, un
 * digest mal construido pasaría en verde contra sí mismo.
 *
 * Receta del contrato (`roax-ops/planning/CONFIOPAGOS_SUSCRIPCIONES.md`
 * §Webhooks/Verificación):
 *   SHA256(data[prop1] + data[prop2] + … + timestamp + WEBHOOK_KEY)
 * en el orden exacto de `signature.properties`, sin separador, hexadecimal en
 * MAYÚSCULA y sin prefijo.
 */
const KEY = 'test-webhook-key'
const TIMESTAMP = 1768384800
const SUBSCRIPTION =
  'stores/01KZBY100Z3HD2X997XE0DN8PW/subscription-plans/01M0Z020DYMXKKDHHR4HAX916R/subscriptions/01M0Z0AAAA'
const PAYMENT = 'organizations/o/stores/s/payments/p3'

const PROPS_EXITOSO = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']
const PROPS_FALLIDO_CON_REASON = [
  'name',
  'cycleNumber',
  'amountCents',
  'currencyCode',
  'status',
  'failedCount',
  'reason',
]
const PROPS_FALLIDO_SIN_REASON = [
  'name',
  'cycleNumber',
  'amountCents',
  'currencyCode',
  'status',
  'failedCount',
]
const PROPS_CAMBIO_DE_ESTADO = ['name', 'status']

/** A — cobro exitoso, 6 propiedades con `payment`. */
const CHECKSUM_A = 'A1E94735E7AFC799304EC6ADEC616F533A815C5FEAF52B835E1F3F4F8E84DF25'
/** B — cobro fallido con `reason: 'INSUFFICIENT_FUNDS'`, 7 propiedades. */
const CHECKSUM_B = '39565AC4B2728AAEE2497ED49E8C5CCBF7C9CFCD435306101F892EA177615D45'
/** C — cobro fallido con `reason: null`, 7 propiedades (el `null` firma "null"). */
const CHECKSUM_C = '274F98FEE59A92FC45A9F581FA936A15A879F996E7AE1DD9132C551826623FB4'
/** D — cobro fallido SIN declarar `reason`, 6 propiedades (fixture vivo). */
const CHECKSUM_D = '4C074FE7DC051C14920088E850E1F376086FBCEF0EA234C712153D603E20B848'
/** E — cambio de estado a PAST_DUE, `['name','status']`. */
const CHECKSUM_E = 'CC367CEFE84C25A5952D1C4F0BE4870ED74F3FCAA6CAC17A52628E6B22864DD3'
/** F — conjunto NO esperado `['name','cycleNumber','status']`, digest correcto para SU conjunto. */
const CHECKSUM_F = 'FABC14F9C0946FF648EAA8B56B0CE2BF4EFC2318AC405D74B2C88FD8C0884A99'

function cobroExitoso(): ConfioWebhookPayload {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUBSCRIPTION,
      payment: PAYMENT,
      cycleNumber: 3,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'SUCCEEDED',
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp: TIMESTAMP,
    signature: { properties: [...PROPS_EXITOSO], checksum: CHECKSUM_A },
  }
}

function cobroFallidoConReason(reason: string | null): ConfioWebhookPayload {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUBSCRIPTION,
      cycleNumber: 3,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'FAILED',
      failedCount: 1,
      reason,
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp: TIMESTAMP,
    signature: {
      properties: [...PROPS_FALLIDO_CON_REASON],
      checksum: reason === null ? CHECKSUM_C : CHECKSUM_B,
    },
  }
}

function cobroFallidoSinReason(): ConfioWebhookPayload {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUBSCRIPTION,
      cycleNumber: 3,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'FAILED',
      failedCount: 1,
      reason: 'INSUFFICIENT_FUNDS',
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp: TIMESTAMP,
    signature: { properties: [...PROPS_FALLIDO_SIN_REASON], checksum: CHECKSUM_D },
  }
}

function cambioDeEstado(): ConfioWebhookPayload {
  return {
    event: 'subscription.subscriptionStatusChanged',
    data: {
      name: SUBSCRIPTION,
      status: 'PAST_DUE',
      createTime: '2026-01-01T10:00:00Z',
      updateTime: '2026-02-14T10:00:00Z',
    },
    timestamp: TIMESTAMP,
    signature: { properties: [...PROPS_CAMBIO_DE_ESTADO], checksum: CHECKSUM_E },
  }
}

describe('verifyConfioWebhookSignature', () => {
  describe('payloads legítimos', () => {
    it('firma el cobro exitoso (6 propiedades con payment)', () => {
      expect(verifyConfioWebhookSignature(cobroExitoso(), KEY)).toEqual({ signed: true })
    })

    it('firma el cobro fallido con reason (7 propiedades)', () => {
      expect(
        verifyConfioWebhookSignature(cobroFallidoConReason('INSUFFICIENT_FUNDS'), KEY),
      ).toEqual({
        signed: true,
      })
    })

    it('firma el cobro fallido con reason null: "null" se concatena como los números', () => {
      // Sin esta regla, TODO cobro fallido con `reason: null` daría firma
      // inválida y el webhook entraría en bucle de 401 sobre la rama de mora.
      expect(verifyConfioWebhookSignature(cobroFallidoConReason(null), KEY)).toEqual({
        signed: true,
      })
    })

    it('firma el cobro fallido que NO declara reason (6 propiedades, fixture vivo)', () => {
      // `confio-webhook.spec.ts:47` declara este conjunto: omitir la variante
      // apaga entera la rama de mora.
      expect(verifyConfioWebhookSignature(cobroFallidoSinReason(), KEY)).toEqual({ signed: true })
    })

    it('firma el cambio de estado de la suscripción', () => {
      expect(verifyConfioWebhookSignature(cambioDeEstado(), KEY)).toEqual({ signed: true })
    })
  })

  describe('checksum recibido: mayúscula, sin prefijo y sin trim', () => {
    it('rechaza el mismo digest en minúscula', () => {
      const payload = cobroExitoso()
      payload.signature!.checksum = CHECKSUM_A.toLowerCase()

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'checksum_mismatch',
      })
    })

    it('rechaza el digest con prefijo sha256=', () => {
      const payload = cobroExitoso()
      payload.signature!.checksum = `sha256=${CHECKSUM_A}`

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'checksum_mismatch',
      })
    })

    it('rechaza el digest con un espacio al final: no hay trim del checksum', () => {
      const payload = cobroExitoso()
      payload.signature!.checksum = `${CHECKSUM_A} `

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'checksum_mismatch',
      })
    })

    it('rechaza un valor de data con espacio al final: tampoco hay trim del valor', () => {
      const payload = cobroExitoso()
      payload.data!.status = 'SUCCEEDED '

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'checksum_mismatch',
      })
    })
  })

  describe('conjunto declarado vs. orden declarado', () => {
    it('una permutación del conjunto esperado pasa la compuerta y muere en el checksum', () => {
      // El conjunto es lo que se valida; el ORDEN declarado es lo que manda el
      // digest. Por eso una permutación NO es `unexpected_properties`.
      const payload = cobroExitoso()
      payload.signature!.properties = [
        'cycleNumber',
        'name',
        'amountCents',
        'currencyCode',
        'status',
        'payment',
      ]

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'checksum_mismatch',
      })
    })

    it('rechaza un conjunto no esperado aunque traiga el digest correcto de ese conjunto', () => {
      const payload = cobroExitoso()
      payload.signature!.properties = ['name', 'cycleNumber', 'status']
      payload.signature!.checksum = CHECKSUM_F

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'unexpected_properties',
      })
    })

    it('rechaza propiedades duplicadas', () => {
      const payload = cobroExitoso()
      payload.signature!.properties = [
        'name',
        'name',
        'amountCents',
        'currencyCode',
        'status',
        'payment',
      ]

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'unexpected_properties',
      })
    })
  })

  describe('coherencia del event (no está cubierto por el checksum)', () => {
    it('rechaza el cambio de estado recapturado como cobro', () => {
      const payload = cambioDeEstado()
      payload.event = 'subscription.billingStatusChanged'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'event_mismatch',
      })
    })

    it('rechaza el cobro recapturado como cambio de estado', () => {
      const payload = cobroExitoso()
      payload.event = 'subscription.subscriptionStatusChanged'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'event_mismatch',
      })
    })
  })

  describe('propiedades declaradas ausentes en data', () => {
    it('rechaza cuando una propiedad declarada no está en data, sin firmar sobre "undefined"', () => {
      const payload = cobroExitoso()
      delete payload.data!.payment

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_data_property',
      })
    })
  })

  describe('payloads malformados: veredicto explícito antes de cualquier cálculo', () => {
    it('clave vacía → missing_key', () => {
      expect(verifyConfioWebhookSignature(cobroExitoso(), '')).toMatchObject({
        signed: false,
        reason: 'missing_key',
      })
    })

    it('sin objeto signature → missing_signature', () => {
      const payload = cobroExitoso()
      delete payload.signature

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_signature',
      })
    })

    it('sin properties → missing_properties', () => {
      const payload = cobroExitoso()
      delete payload.signature!.properties

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_properties',
      })
    })

    it('properties no-array → missing_properties', () => {
      const payload = cobroExitoso()
      ;(payload.signature as any).properties = 'name,status'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_properties',
      })
    })

    it('sin checksum → missing_checksum', () => {
      const payload = cobroExitoso()
      delete payload.signature!.checksum

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_checksum',
      })
    })

    it('checksum no-string → missing_checksum', () => {
      const payload = cobroExitoso()
      ;(payload.signature as any).checksum = 123

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_checksum',
      })
    })
  })

  describe('tipos de los valores firmados: la frontera entre campos no se mueve', () => {
    // El digest concatena SIN separador, así que mover un dígito de un campo al
    // vecino deja el MISMO string firmado. Los dos vectores de abajo son el
    // cobro legítimo A —mismo `signature.properties`, mismo `event` y el
    // CHECKSUM_A intacto— con la frontera corrida: `'3'+'5000000'` concatena
    // igual que `'35'+'000000'`, y `'5000000'+'COP'` igual que `'500000'+'0COP'`.
    // Sin chequeo de tipo el checksum COINCIDE y el cobro del ciclo 3 se
    // reprocesa como ciclo 35 por un importe elegido por el atacante.
    it('rechaza el corrimiento cycleNumber/amountCents que conserva el checksum legítimo', () => {
      const payload = cobroExitoso()
      payload.data!.cycleNumber = 35
      ;(payload.data as any).amountCents = '000000'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
    })

    it('rechaza el corrimiento amountCents/currencyCode que conserva el checksum legítimo', () => {
      const payload = cobroExitoso()
      payload.data!.amountCents = 500000
      payload.data!.currencyCode = '0COP'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
    })

    it('rechaza currencyCode que no sea el ISO de tres letras en mayúscula', () => {
      const payload = cobroExitoso()
      payload.data!.currencyCode = 'cop'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
    })

    it('rechaza un name no-string', () => {
      const payload = cobroExitoso()
      ;(payload.data as any).name = 42

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
    })

    it('rechaza un failedCount no numérico', () => {
      const payload = cobroFallidoConReason('INSUFFICIENT_FUNDS')
      ;(payload.data as any).failedCount = '1'

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
    })

    it('rechaza un amountCents no finito', () => {
      const payload = cobroExitoso()
      payload.data!.amountCents = Number.NaN

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
    })

    it('rechaza un reason numérico pero SIGUE aceptando reason null', () => {
      const conNumero = cobroFallidoConReason(null)
      ;(conNumero.data as any).reason = 7

      expect(verifyConfioWebhookSignature(conNumero, KEY)).toMatchObject({
        signed: false,
        reason: 'invalid_data_type',
      })
      // Criterio (2): un `reason: null` legítimo debe seguir firmando, o todo
      // cobro fallido entra en bucle de 401.
      expect(verifyConfioWebhookSignature(cobroFallidoConReason(null), KEY)).toEqual({
        signed: true,
      })
    })
  })

  describe('timestamp del envelope', () => {
    it('rechaza el payload sin timestamp en vez de firmar sobre "undefined"', () => {
      const payload = cobroExitoso()
      delete payload.timestamp

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_timestamp',
      })
    })

    it('rechaza un timestamp que no es un escalar del envelope', () => {
      const payload = cobroExitoso()
      ;(payload as any).timestamp = { seconds: TIMESTAMP }

      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({
        signed: false,
        reason: 'missing_timestamp',
      })
    })

    it('acepta el timestamp como string: entra al digest tal como viaja', () => {
      const payload = cobroExitoso()
      payload.timestamp = String(TIMESTAMP)

      expect(verifyConfioWebhookSignature(payload, KEY)).toEqual({ signed: true })
    })
  })

  describe('detail: eco del emisor acotado y sin caracteres de control', () => {
    it('no deja que un event con saltos de línea forje líneas de log', () => {
      const payload = cobroExitoso()
      payload.event = 'subscription.subscriptionStatusChanged\nfirma OK\u001B[31m'

      const verdict = verifyConfioWebhookSignature(payload, KEY)

      expect(verdict).toMatchObject({ signed: false, reason: 'event_mismatch' })
      expect((verdict as { detail: string }).detail).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/)
    })

    it('acota el detail cuando el emisor declara un properties gigante', () => {
      const payload = cobroExitoso()
      payload.signature!.properties = Array.from({ length: 500 }, () => 'name')

      const verdict = verifyConfioWebhookSignature(payload, KEY)

      expect(verdict).toMatchObject({ signed: false, reason: 'unexpected_properties' })
      expect((verdict as { detail: string }).detail.length).toBeLessThanOrEqual(200)
    })
  })

  describe('blindaje: una entrada crafteada nunca tira TypeError', () => {
    const crafteados: [string, any][] = [
      ['payload null', null],
      ['payload undefined', undefined],
      ['data null', { ...cobroExitoso(), data: null }],
      ['data string', { ...cobroExitoso(), data: 'x' }],
      ['data con hasOwnProperty propio', { ...cobroExitoso(), data: { hasOwnProperty: 1 } }],
      [
        'properties con entradas no-string',
        { ...cobroExitoso(), signature: { properties: [null], checksum: CHECKSUM_A } },
      ],
      [
        'checksum no-string',
        { ...cobroExitoso(), signature: { properties: [...PROPS_EXITOSO], checksum: {} } },
      ],
    ]

    it.each(crafteados)('%s no lanza y da veredicto negativo', (_nombre, payload) => {
      expect(() => verifyConfioWebhookSignature(payload, KEY)).not.toThrow()
      expect(verifyConfioWebhookSignature(payload, KEY)).toMatchObject({ signed: false })
    })
  })
})
