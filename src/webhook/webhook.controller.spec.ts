import { Test, TestingModule } from '@nestjs/testing'
import { RawBodyRequest } from '@nestjs/common'
import { Request } from 'express'

import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { ConfioProvider } from '../provider/confio/confio.provider'

/** Request con `rawBody`, que es lo único que el handler lee del pedido. */
function reqCon(payload: unknown): RawBodyRequest<Request> {
  return { rawBody: Buffer.from(JSON.stringify(payload)) } as RawBodyRequest<Request>
}

function cobro(cycleNumber: number) {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: 'stores/s/subscription-plans/p/subscriptions/sub',
      payment: `organizations/o/stores/s/payments/p${cycleNumber}`,
      cycleNumber,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'SUCCEEDED',
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp: 1768384800,
  }
}

describe('WebhookController (confio)', () => {
  let controller: WebhookController
  let webhookService: { receive: jest.Mock }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: { receive: jest.fn().mockResolvedValue({ data: {} }) } },
        { provide: StripeProvider, useValue: {} },
        { provide: MercadoPagoProvider, useValue: {} },
        { provide: DropiProvider, useValue: {} },
        { provide: ConfioProvider, useValue: { validateWebhookSignature: jest.fn().mockReturnValue(true) } },
      ],
    }).compile()

    controller = module.get<WebhookController>(WebhookController)
    webhookService = module.get(WebhookService)
  })

  it('manda una clave distinta por ciclo cobrado', async () => {
    await controller.confio('Bearer k', reqCon(cobro(3)))
    await controller.confio('Bearer k', reqCon(cobro(4)))

    const [primera, segunda] = webhookService.receive.mock.calls.map((c) => c[2])
    expect(primera).not.toEqual(segunda)
  })
})
