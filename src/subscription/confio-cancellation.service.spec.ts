import { Test, TestingModule } from '@nestjs/testing'
import { HttpStatus } from '@nestjs/common'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioApiError } from '../provider/confio/confio-api-error'
import { ConfioProvider } from '../provider/confio/confio.provider'
import {
  ConfioSubscriptionInputError,
  ConfioSubscriptionInputField,
} from '../provider/confio/confio-subscription-error'
import { ProviderPaymentNotFoundError } from '../provider/provider.interface'
import { RequestException } from '../shared/exception/request.exception'

const CONFIO_PLAN = 'stores/store-1/subscription-plans/plan-1'
const CONFIO_SUB = `${CONFIO_PLAN}/subscriptions/sub-1`
const REASON = 'el usuario canceló la renovación'

describe('ConfioCancellationService', () => {
  let service: ConfioCancellationService
  let confio: { cancelSubscription: jest.Mock }

  beforeEach(async () => {
    confio = { cancelSubscription: jest.fn().mockResolvedValue(undefined) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [ConfioCancellationService, { provide: ConfioProvider, useValue: confio }],
    }).compile()

    service = module.get(ConfioCancellationService)
  })

  it('delega en el provider con el resource name y el motivo', async () => {
    await expect(service.cancel(CONFIO_SUB, REASON)).resolves.toBeUndefined()

    expect(confio.cancelSubscription).toHaveBeenCalledWith(CONFIO_SUB, REASON)
  })

  /**
   * Los dos rechazos LOCALES que hablan de configuración NUESTRA, no de algo que
   * el llamador pueda corregir: 503 con código propio y sin reexponer el `detail`
   * (lleva el store esperado y el name guardado).
   *
   * `invalid_subscription_name` es el caso que fija la restricción 1 de la
   * aceptación: NO puede terminar en una cancelación local. Acá se convierte en
   * excepción, y el dominio la deja propagar sin escribir nada.
   *
   * Este spec prueba el MAPEO, no que el provider produzca esos rechazos: quien
   * demuestra que los DOS son alcanzables desde la cancelación —store ajeno y
   * forma inválida, los dos sin tocar la red— es `confio.provider.spec.ts`,
   * contra su servidor HTTP de prueba. Fabricar el error acá sin ese respaldo
   * sería un verde sobre un control inexistente.
   */
  it.each<[string, ConfioSubscriptionInputField, string]>([
    ['invalid_subscription_name', 'name', 'CONFIO_SUBSCRIPTION_NAME_INVALID'],
    ['plan_store_mismatch', 'name', 'CONFIO_PLAN_STORE_MISMATCH'],
  ])('%s → 503 %s, sin filtrar el detalle', async (code, field, expected) => {
    confio.cancelSubscription.mockRejectedValue(
      new ConfioSubscriptionInputError(code as any, field, 'no pertenece al store configurado'),
    )

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.code).toBe(expected)
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(JSON.stringify(error.getResponse())).not.toContain('store configurado')
  })

  it('missing_cancel_reason → 422 CANCEL_REASON_REQUIRED: eso sí lo arregla el llamador', async () => {
    confio.cancelSubscription.mockRejectedValue(
      new ConfioSubscriptionInputError(
        'missing_cancel_reason',
        'reason',
        'ConfioPagos exige un motivo para cancelar la suscripción',
      ),
    )

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.code).toBe('CANCEL_REASON_REQUIRED')
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(error.getResponse()).toMatchObject({ field: 'reason' })
  })

  it('cualquier otro fallo (red, 5xx) → 503 CONFIO_CANCEL_UNAVAILABLE sin el cuerpo de Confío', async () => {
    confio.cancelSubscription.mockRejectedValue(
      new Error('ConfioPagos error 500: {"message":"internal","traceId":"abc"}'),
    )

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.code).toBe('CONFIO_CANCEL_UNAVAILABLE')
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    // Un fallo del canal no es un hecho sobre el objeto, y su cuerpo no vuelve al cliente.
    expect(JSON.stringify(error.getResponse())).not.toContain('traceId')
    expect(JSON.stringify(error.getResponse())).not.toContain('internal')
  })

  it.each([
    ['a 400', new ConfioApiError('ConfioPagos error 400', 400, 'INVALID_ARGUMENT')],
    ['a 404', new ProviderPaymentNotFoundError('ConfioPagos error 404')],
  ])('answers %s from ConfioPagos with 502 CONFIO_CANCEL_REJECTED', async (_, rejection) => {
    // Mutation (both rows): isPermanentRejection returns false -> the 503 branch answers, red.
    confio.cancelSubscription.mockRejectedValue(rejection)

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY)
    expect(error.getResponse()).toMatchObject({ code: 'CONFIO_CANCEL_REJECTED' })
  })

  it.each([
    ['a 408', new ConfioApiError('ConfioPagos error 408', 408)],
    ['a 429', new ConfioApiError('ConfioPagos error 429', 429)],
    ['a 500', new ConfioApiError('ConfioPagos error 500', 500)],
    ['a timeout', Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })],
  ])('answers %s from ConfioPagos with 503 CONFIO_CANCEL_UNAVAILABLE', async (_, rejection) => {
    // Mutation (408, 429 rows): isPermanentRejection drops its 408/429 exclusion; (500 row): drops `< 500`.
    // Mutation (timeout row): isPermanentRejection returns true for an error that is not a ConfioApiError.
    confio.cancelSubscription.mockRejectedValue(rejection)

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(error.getResponse()).toMatchObject({ code: 'CONFIO_CANCEL_UNAVAILABLE' })
  })

  it('un rechazo que no es Error tampoco rompe el envoltorio', async () => {
    confio.cancelSubscription.mockRejectedValue('caída sin objeto')

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.code).toBe('CONFIO_CANCEL_UNAVAILABLE')
  })
})
