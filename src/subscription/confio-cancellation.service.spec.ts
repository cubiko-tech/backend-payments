import { Test, TestingModule } from '@nestjs/testing'
import { HttpStatus } from '@nestjs/common'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
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
      providers: [
        ConfioCancellationService,
        { provide: ConfioProvider, useValue: confio },
      ],
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
  it.each([
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

  it('un rechazo que no es Error tampoco rompe el envoltorio', async () => {
    confio.cancelSubscription.mockRejectedValue('caída sin objeto')

    const error = await service.cancel(CONFIO_SUB, REASON).catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.code).toBe('CONFIO_CANCEL_UNAVAILABLE')
  })
})
