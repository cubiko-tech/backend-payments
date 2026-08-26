import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { getQueueToken } from '@nestjs/bullmq'
import { QueryFailedError } from 'typeorm'

import { WebhookService } from './webhook.service'
import { WebhookEvent } from './entities/webhookEvent.entity'
import { Payment } from '../payment/entities/payment.entity'

/**
 * Error tal como lo entrega el driver: `code` y `constraint` copiados de una
 * sonda real contra la BD de dev (insert duplicado en `webhook_events`, que
 * devolvió `code=23505 constraint=UQ_webhook_events_provider_id`). TypeORM
 * asigna las propiedades del error del driver sobre el `QueryFailedError`.
 */
function violacionDeUnico(): Error {
  const driverError: any = new Error(
    'duplicate key value violates unique constraint "UQ_webhook_events_provider_id"',
  )
  driverError.code = '23505'
  driverError.constraint = 'UQ_webhook_events_provider_id'
  driverError.severity = 'ERROR'
  return new QueryFailedError('INSERT INTO webhook_events', [], driverError)
}

/** Falla que NO es de unicidad: caída de conexión. */
function conexionCaida(): Error {
  const driverError: any = new Error('connection terminated unexpectedly')
  driverError.code = '08006'
  return new QueryFailedError('INSERT INTO webhook_events', [], driverError)
}

const EVENT_ID = 'stores/s/subscription-plans/p/subscriptions/sub:subscription.billingStatusChanged:ciclo-3'

describe('WebhookService.receive', () => {
  let service: WebhookService
  let writeRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock }
  let readRepo: { findOne: jest.Mock }
  let paymentReadRepo: { findOne: jest.Mock }
  let queue: { add: jest.Mock }

  beforeEach(async () => {
    writeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d) => d),
      save: jest.fn((d) => Promise.resolve({ id: 'we-1', ...d })),
    }
    readRepo = { findOne: jest.fn().mockResolvedValue(null) }
    paymentReadRepo = { findOne: jest.fn() }
    queue = { add: jest.fn().mockResolvedValue(undefined) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(WebhookEvent, 'DBWrite'), useValue: writeRepo },
        { provide: getRepositoryToken(WebhookEvent, 'DBRead'), useValue: readRepo },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: paymentReadRepo },
        { provide: getQueueToken('webhook-retry'), useValue: queue },
      ],
    }).compile()

    service = module.get<WebhookService>(WebhookService)
  })

  function recibir() {
    return service.receive('confio', 'subscription.billingStatusChanged', EVENT_ID, { event: 'x' })
  }

  it('consulta la idempotencia contra la escritura, no contra la réplica', async () => {
    await recibir()

    expect(writeRepo.findOne).toHaveBeenCalledWith({ where: { providerEventId: EVENT_ID } })
    expect(readRepo.findOne).not.toHaveBeenCalled()
  })

  it('descarta la reentrega que el chequeo previo ya encuentra', async () => {
    writeRepo.findOne.mockResolvedValue({ id: 'we-existente', providerEventId: EVENT_ID })

    const res = await recibir()

    expect(res).toEqual({ data: { id: 'we-existente', providerEventId: EVENT_ID }, duplicate: true })
    expect(writeRepo.save).not.toHaveBeenCalled()
  })

  it('trata la violación del índice único como duplicado, no como fallo', async () => {
    // Dos entregas concurrentes: las dos pasan el chequeo previo y una pierde el insert.
    writeRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'we-ganador', providerEventId: EVENT_ID })
    writeRepo.save.mockRejectedValueOnce(violacionDeUnico())

    const res = await recibir()

    expect(res).toEqual({ data: { id: 'we-ganador', providerEventId: EVENT_ID }, duplicate: true })
    // Un solo `save`: el insert que perdió. Si hubiera despacho, `processEvent`
    // volvería a guardar el evento para marcarlo PROCESSING.
    expect(writeRepo.save).toHaveBeenCalledTimes(1)
  })

  it('deja fallar cualquier otro error de base', async () => {
    writeRepo.save.mockRejectedValueOnce(conexionCaida())

    const res = await recibir()

    expect(res).toHaveProperty('error')
    expect((res as { duplicate?: boolean }).duplicate).toBeUndefined()
  })
})
