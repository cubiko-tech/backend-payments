import {
  buildConfioWebhookEventId,
  buildLegacyConfioStatusChangedEventId,
  classifyConfioWebhookEvent,
} from './confio-webhook'
import {
  CONFIO_WEBHOOK_TIMESTAMP_WINDOW_MS,
  MAX_CONFIO_REASON_LENGTH,
  MAX_CONFIO_STRING_LENGTH,
  verifyConfioWebhookSignature,
} from './confio-webhook-signature'
import { ConfioWebhookPayload } from './confio.types'

/**
 * Payloads copiados de `roax-ops/planning/CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks,
 * no inventados: el cobro exitoso trae `payment` y el fallido lo cambia por
 * `failedCount` + `reason`.
 */
const SUBSCRIPTION =
  'stores/01KZBY100Z3HD2X997XE0DN8PW/subscription-plans/01M0Z020DYMXKKDHHR4HAX916R/subscriptions/01M0Z0AAAA'

function cobroExitoso(
  cycleNumber: number,
  payment: string,
  timestamp = 1768384800,
): ConfioWebhookPayload {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUBSCRIPTION,
      payment,
      cycleNumber,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'SUCCEEDED',
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp,
    signature: {
      properties: ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment'],
      checksum: '4F6A',
    },
  }
}

function cobroFallido(cycleNumber: number, failedCount: number): ConfioWebhookPayload {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUBSCRIPTION,
      cycleNumber,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'FAILED',
      failedCount,
      reason: 'INSUFFICIENT_FUNDS',
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp: 1768384800,
    signature: {
      properties: ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'failedCount'],
      checksum: '4F6A',
    },
  }
}

function cambioDeEstado(
  status: string,
  updateTime: string,
  timestamp = 1768384800,
): ConfioWebhookPayload {
  return {
    event: 'subscription.subscriptionStatusChanged',
    data: {
      name: SUBSCRIPTION,
      status,
      createTime: '2026-01-01T10:00:00Z',
      updateTime,
    },
    timestamp,
    signature: { properties: ['name', 'status'], checksum: '4F6A' },
  }
}

describe('buildConfioWebhookEventId', () => {
  describe('subscription.billingStatusChanged', () => {
    it('distingue dos cobros exitosos de ciclos distintos', () => {
      const ciclo3 = buildConfioWebhookEventId(
        cobroExitoso(3, 'organizations/o/stores/s/payments/p3'),
      )
      const ciclo4 = buildConfioWebhookEventId(
        cobroExitoso(4, 'organizations/o/stores/s/payments/p4'),
      )

      expect(ciclo3).not.toEqual(ciclo4)
    })

    it('da la misma clave a la misma notificación reentregada', () => {
      const payload = cobroExitoso(3, 'organizations/o/stores/s/payments/p3')

      expect(buildConfioWebhookEventId(payload)).toEqual(buildConfioWebhookEventId(payload))
    })

    it('distingue dos intentos fallidos del mismo ciclo', () => {
      expect(buildConfioWebhookEventId(cobroFallido(3, 1))).not.toEqual(
        buildConfioWebhookEventId(cobroFallido(3, 2)),
      )
    })

    it('distingue el fallo del éxito dentro del mismo ciclo', () => {
      const fallido = buildConfioWebhookEventId(cobroFallido(3, 1))
      const exitoso = buildConfioWebhookEventId(
        cobroExitoso(3, 'organizations/o/stores/s/payments/p3'),
      )

      expect(fallido).not.toEqual(exitoso)
    })

    it('sin cycleNumber cae al timestamp firmado, no a una constante', () => {
      const sinCiclo = (timestamp: number): ConfioWebhookPayload => {
        const p = cobroExitoso(0, 'organizations/o/stores/s/payments/p', timestamp)
        delete p.data!.cycleNumber
        delete p.data!.payment
        return p
      }

      expect(buildConfioWebhookEventId(sinCiclo(1768384800))).not.toEqual(
        buildConfioWebhookEventId(sinCiclo(1768388400)),
      )
    })
  })

  describe('subscription.subscriptionStatusChanged', () => {
    it('no colapsa ACTIVE → PAST_DUE → ACTIVE en una sola clave', () => {
      const claves = [
        buildConfioWebhookEventId(cambioDeEstado('ACTIVE', '2026-01-14T10:00:00Z', 1768384800)),
        buildConfioWebhookEventId(cambioDeEstado('PAST_DUE', '2026-02-14T10:00:00Z', 1771063200)),
        buildConfioWebhookEventId(cambioDeEstado('ACTIVE', '2026-02-15T10:00:00Z', 1771149600)),
      ]

      expect(new Set(claves).size).toBe(3)
    })

    it('da la misma clave a la reentrega del cambio del medio', () => {
      const mora = cambioDeEstado('PAST_DUE', '2026-02-14T10:00:00Z')

      expect(buildConfioWebhookEventId(mora)).toEqual(buildConfioWebhookEventId({ ...mora }))
    })

    it('produces the exact same key when unsigned updateTime, createTime, or correlationId are mutated', () => {
      // R15: red if buildConfioWebhookEventId reads unsigned updateTime, createTime, or correlationId.
      const original = cambioDeEstado('PAST_DUE', '2026-02-14T10:00:00Z', 1768384800)
      const mutated: ConfioWebhookPayload = {
        ...original,
        data: {
          ...original.data,
          updateTime: '2099-12-31T23:59:59Z',
          createTime: '1999-01-01T00:00:00Z',
          correlationId: 'forged-correlation-id',
        },
      }

      expect(buildConfioWebhookEventId(mutated)).toBe(buildConfioWebhookEventId(original))
      expect(buildLegacyConfioStatusChangedEventId(original)).toBe(
        `${SUBSCRIPTION}:subscription.subscriptionStatusChanged:PAST_DUE:2026-02-14T10:00:00Z`,
      )
    })
  })

  describe('signed billingStatusChanged ignores unsigned fields', () => {
    it('produces the exact same key when unsigned correlationId or createTime are mutated', () => {
      // R15: red if buildConfioWebhookEventId reads unsigned correlationId or createTime on billingStatusChanged.
      const original = cobroExitoso(3, 'organizations/o/stores/s/payments/p3')
      const mutated: ConfioWebhookPayload = {
        ...original,
        data: {
          ...original.data,
          correlationId: 'attacker-injected-correlation-id',
          createTime: '2030-05-01T00:00:00Z',
        },
      }

      expect(buildConfioWebhookEventId(mutated)).toBe(buildConfioWebhookEventId(original))
    })

    it('does not include payment in the key when payment is not in signature.properties', () => {
      // R15: red if buildConfioWebhookEventId includes data.payment without checking signature.properties.
      const failed = cobroFallido(3, 1)
      const withUnsignedPayment: ConfioWebhookPayload = {
        ...failed,
        data: {
          ...failed.data,
          payment: 'organizations/o/stores/s/payments/forged',
        },
      }

      expect(buildConfioWebhookEventId(withUnsignedPayment)).toBe(buildConfioWebhookEventId(failed))
    })
  })

  describe('eventos one-shot (camino legacy congelado)', () => {
    it('mantiene byte a byte la clave del link de pago', () => {
      const payload: ConfioWebhookPayload = {
        event: 'payment.statusChanged',
        data: {
          name: 'stores/01KZBY100Z3HD2X997XE0DN8PW/payments/01M0Z0BBBB',
          status: 'FUNDED',
        },
        timestamp: 1768384800,
      }

      expect(buildConfioWebhookEventId(payload)).toBe(
        'stores/01KZBY100Z3HD2X997XE0DN8PW/payments/01M0Z0BBBB:FUNDED',
      )
    })
  })
})

describe('classifyConfioWebhookEvent', () => {
  // Mutación que pone rojo el ramo firmado: devolver 'one_shot' para estos dos.
  it('manda al ramo firmado los dos eventos de suscripción', () => {
    expect(classifyConfioWebhookEvent('subscription.billingStatusChanged')).toBe('firmado')
    expect(classifyConfioWebhookEvent('subscription.subscriptionStatusChanged')).toBe('firmado')
  })

  // Mutación que lo pone rojo: mandar el par one-shot a 'fuera_de_contrato'.
  // Sería apagar tráfico VIVO: llegan sin objeto `signature` (fixture de abajo)
  // y `webhook.service.ts:236-256` los despacha por `data.status`.
  it('manda al ramo one-shot los dos eventos del link de pago', () => {
    expect(classifyConfioWebhookEvent('payment.statusChanged')).toBe('one_shot')
    expect(classifyConfioWebhookEvent('paymentAttempt.statusChanged')).toBe('one_shot')
  })

  // Mutación que lo pone rojo: devolver 'one_shot' por defecto.
  it('deja fuera del contrato lo que no está en la tabla publicada', () => {
    expect(classifyConfioWebhookEvent('invoice.created')).toBe('fuera_de_contrato')
    expect(classifyConfioWebhookEvent(undefined)).toBe('fuera_de_contrato')
    expect(classifyConfioWebhookEvent('')).toBe('fuera_de_contrato')
    expect(classifyConfioWebhookEvent({ event: 'subscription.billingStatusChanged' })).toBe(
      'fuera_de_contrato',
    )
  })
})

describe('verifyConfioWebhookSignature timestamp window and string length bounds', () => {
  const KEY = 'test-webhook-key'
  const TIMESTAMP = 1768384800
  const CHECKSUM_A = 'A1E94735E7AFC799304EC6ADEC616F533A815C5FEAF52B835E1F3F4F8E84DF25'

  function signedBillingPayload(): ConfioWebhookPayload {
    const payload = cobroExitoso(3, 'organizations/o/stores/s/payments/p3', TIMESTAMP)
    payload.signature!.checksum = CHECKSUM_A
    return payload
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('rejects a validly signed notice when timestamp is older than 24h or more than 24h in the future', () => {
    // R15: red if verifyConfioWebhookSignature omits the 24h timestamp window check.
    // R17: Shift wall-clock time past the 24h window without sleeping.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(TIMESTAMP * 1000 + CONFIO_WEBHOOK_TIMESTAMP_WINDOW_MS + 1000)
    expect(verifyConfioWebhookSignature(signedBillingPayload(), KEY)).toMatchObject({
      signed: false,
      reason: 'timestamp_out_of_window',
    })

    // R17: Shift wall-clock time before the 24h window without sleeping.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(TIMESTAMP * 1000 - CONFIO_WEBHOOK_TIMESTAMP_WINDOW_MS - 1000)
    expect(verifyConfioWebhookSignature(signedBillingPayload(), KEY)).toMatchObject({
      signed: false,
      reason: 'timestamp_out_of_window',
    })
  })

  it('accepts a validly signed notice within the 24h retry window', () => {
    // R15: red if verifyConfioWebhookSignature rejects timestamps inside the 24h window.
    // R17: Pin wall-clock time just inside the 24h window boundary.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(TIMESTAMP * 1000 + CONFIO_WEBHOOK_TIMESTAMP_WINDOW_MS - 1000)
    expect(verifyConfioWebhookSignature(signedBillingPayload(), KEY)).toEqual({
      signed: true,
    })
  })

  it('rejects oversized signed or optional strings and oversized buyer objects before digest comparison', () => {
    // R15: red if verifyConfioWebhookSignature omits string length bounds on signed or optional fields.
    // R17: Pin wall-clock time to the signed fixture timestamp.
    jest.spyOn(Date, 'now').mockReturnValue(TIMESTAMP * 1000)

    const longName = signedBillingPayload()
    longName.data!.name = 's'.repeat(MAX_CONFIO_STRING_LENGTH + 1)
    expect(verifyConfioWebhookSignature(longName, KEY)).toMatchObject({
      signed: false,
      reason: 'invalid_data_type',
    })

    const longReason = cobroFallido(3, 1)
    longReason.signature!.properties = [
      'name',
      'cycleNumber',
      'amountCents',
      'currencyCode',
      'status',
      'failedCount',
      'reason',
    ]
    longReason.signature!.checksum = 'A'.repeat(64)
    longReason.data!.reason = 'r'.repeat(MAX_CONFIO_REASON_LENGTH + 1)
    expect(verifyConfioWebhookSignature(longReason, KEY)).toMatchObject({
      signed: false,
      reason: 'invalid_data_type',
    })

    const longCorrelation = signedBillingPayload()
    longCorrelation.data!.correlationId = 'c'.repeat(129)
    expect(verifyConfioWebhookSignature(longCorrelation, KEY)).toMatchObject({
      signed: false,
      reason: 'invalid_data_type',
    })
  })
})
