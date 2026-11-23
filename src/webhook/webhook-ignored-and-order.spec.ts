import { Logger } from '@nestjs/common'

import { WebhookStatus } from './entities/webhookEvent.entity'
import { WebhookService } from './webhook.service'

/** How the webhook service keeps a notice it does not apply: `ignored` and `out_of_order`. */
describe('WebhookService — ignored and out-of-order notices', () => {
  let events: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock }
  let confio: { handle: jest.Mock }
  let checkout: { completeExternalPayment: jest.Mock }
  let service: WebhookService

  beforeEach(() => {
    // R17: the event table is what these cases decide over (its status); the Confio handler, the
    // checkout and BullMQ are other units, so only their calls are read.
    events = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (row: any) => ({ id: 'we-1', ...row })),
      create: jest.fn((row: any) => ({ ...row })),
    }
    confio = { handle: jest.fn().mockResolvedValue('applied') }
    checkout = { completeExternalPayment: jest.fn().mockResolvedValue(undefined) }
    service = new WebhookService(
      events as any,
      events as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'pay-1' }) } as any,
      { add: jest.fn().mockResolvedValue(undefined) } as any,
      confio as any,
      {} as any,
    )
    service.setCheckoutService(checkout)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  const lastSaved = () => events.save.mock.calls[events.save.mock.calls.length - 1][0]
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  it('keeps an event outside the contract as ignored, under its own key, without dispatching', async () => {
    // R15: red if the ignored event keeps the one-shot key, which carries no event name.
    const payload = {
      event: 'invoice.created',
      data: { name: 'stores/s/payments/p1', status: 'FUNDED' },
    }

    await service.recordIgnored('confio', 'invoice.created', 'stores/s/payments/p1:FUNDED', payload)

    expect(lastSaved()).toEqual(
      expect.objectContaining({
        provider: 'confio',
        providerEventId: 'ignored:invoice.created:stores/s/payments/p1:FUNDED',
        status: WebhookStatus.IGNORED,
        payload,
      }),
    )
    expect(confio.handle).not.toHaveBeenCalled()
  })

  it('a notice the Confio handler finds out of order is stored out_of_order, not processed', async () => {
    // R15: red if `processEvent` marks every handled notice `processed`.
    confio.handle.mockResolvedValue('out_of_order')
    const payload = { event: 'subscription.subscriptionStatusChanged', data: { status: 'EXPIRED' } }

    await service.receive('confio', payload.event, 'k-old', payload)
    await flush()

    expect(lastSaved().status).toBe(WebhookStatus.OUT_OF_ORDER)
    expect(lastSaved().processedAt).toBeInstanceOf(Date)
  })

  it('scenario 10: retrying an ignored event does not dispatch it', async () => {
    // R15: red if `retryWebhook` accepts an ignored event: its `data.status` would complete a payment.
    const row = {
      id: 'we-ignored',
      provider: 'confio',
      eventType: 'invoice.created',
      providerEventId: 'ignored:invoice.created:stores/s/payments/p1:FUNDED',
      payload: {
        event: 'invoice.created',
        data: { name: 'stores/s/payments/p1', status: 'FUNDED' },
      },
      status: WebhookStatus.IGNORED,
    }
    events.findOne.mockResolvedValue(row)

    const answer = await service.retryWebhook('we-ignored')
    await flush()

    expect(answer).toEqual({ error: expect.stringContaining('ignored') })
    expect(events.save).not.toHaveBeenCalled()
    expect(checkout.completeExternalPayment).not.toHaveBeenCalled()
    expect(row.status).toBe(WebhookStatus.IGNORED)
  })

  it('retrying an out-of-order notice does not dispatch it either', async () => {
    // R15: red if `retryWebhook` accepts an out-of-order notice and dispatches it again.
    events.findOne.mockResolvedValue({ id: 'we-old', status: WebhookStatus.OUT_OF_ORDER })

    expect(await service.retryWebhook('we-old')).toEqual({ error: expect.any(String) })
    expect(confio.handle).not.toHaveBeenCalled()
  })
})
