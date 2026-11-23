import { Logger } from '@nestjs/common'

import { ConfioSubscriptionWebhookService } from './confio-subscription-webhook.service'
import { WebhookStatus } from './entities/webhookEvent.entity'
import {
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'

const NAME = 'stores/s/subscription-plans/p/subscriptions/order'
const SUB_ID = '22222222-2222-4222-8222-222222222222'
const T0 = 1768384800
const NOW = new Date('2026-01-14T10:00:00Z')

const charge = (cycle: number, timestamp: number, status = 'SUCCEEDED') => ({
  event: 'subscription.billingStatusChanged',
  data: { name: NAME, cycleNumber: cycle, amountCents: 1990000, status, payment: `p${cycle}` },
  timestamp,
  signature: { properties: ['name', 'cycleNumber', 'status'], checksum: 'AB' },
})

const statusChange = (status: string, timestamp: number) => ({
  event: 'subscription.subscriptionStatusChanged',
  data: { name: NAME, status },
  timestamp,
  signature: { properties: ['name', 'status'], checksum: 'CD' },
})

const event = (payload: any, providerEventId: string): any => ({
  id: 'we-order',
  provider: 'confio',
  eventType: payload.event,
  providerEventId,
  payload,
  status: WebhookStatus.RECEIVED,
})

const row = (over: Record<string, any> = {}): any => ({
  id: SUB_ID,
  brandId: 'brand-order',
  userId: 'user-order',
  planSlug: 'pro',
  status: SubscriptionStatus.ACTIVE,
  provider: SubscriptionProvider.CONFIO,
  providerSubscriptionId: NAME,
  currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
  autoRenew: true,
  cancelledAt: null,
  providerWatermark: null,
  ...over,
})

/** Chainable builder; `getOne` answers `found`, the insert and the update record their calls. */
function builder(found: any = null) {
  const b: any = {}
  for (const m of ['where', 'andWhere', 'insert', 'into', 'values', 'orIgnore', 'update', 'set']) {
    b[m] = jest.fn(() => b)
  }
  b.execute = jest.fn().mockResolvedValue({})
  b.getOne = jest.fn().mockResolvedValue(found)
  return b
}

describe('ConfioSubscriptionWebhookService — notices in order and their pending trace', () => {
  let subRepo: { findOne: jest.Mock }
  let eventRepo: { createQueryBuilder: jest.Mock }
  let manager: any
  let dataSource: { transaction: jest.Mock }
  let roles: { assignPlanToBrand: jest.Mock; removePlanFromBrand: jest.Mock }
  let service: ConfioSubscriptionWebhookService
  let warn: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'], now: NOW })
    // R17: the order guards decide over repositories, the transaction and roles; PostgreSQL runs in the
    // e2e. ConfioPagos is down, so the period is the local one; the bonus has its own suites.
    subRepo = { findOne: jest.fn() }
    eventRepo = { createQueryBuilder: jest.fn(() => builder()) }
    manager = {
      findOne: jest.fn(),
      save: jest.fn((...args: any[]) => Promise.resolve(args[args.length - 1])),
      createQueryBuilder: jest.fn(() => builder()),
    }
    dataSource = { transaction: jest.fn((cb: any) => cb(manager)) }
    roles = {
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
    }
    service = new ConfioSubscriptionWebhookService(
      subRepo as any,
      eventRepo as any,
      dataSource as any,
      { getSubscription: jest.fn().mockRejectedValue(new Error('down')) } as any,
      roles as any,
      { plan: jest.fn().mockResolvedValue(null) } as any,
    )
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  const savedRow = () => manager.save.mock.calls.find((c: any[]) => c[0] !== SubscriptionEvent)?.[0]
  const savedTraces = () =>
    manager.save.mock.calls.filter((c: any[]) => c[0] === SubscriptionEvent).map((c) => c[1])

  it('scenario 1: an EXPIRED older than the applied charge leaves the row and roles alone', async () => {
    // R15: red if `isOutOfOrder` is not checked: the row is downgraded and roles gets the downgrade.
    const sub = row({
      providerWatermark: { name: NAME, cycle: 3, at: new Date(T0 * 1000).toISOString() },
    })
    subRepo.findOne.mockResolvedValue(sub)
    manager.findOne.mockResolvedValue(sub)

    const outcome = await service.handle(event(statusChange('EXPIRED', T0 - 60), 'ev-expired'))

    expect(outcome).toBe('out_of_order')
    expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
    expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
    expect(dataSource.transaction).not.toHaveBeenCalled()
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
  })

  it('an applied charge moves the mark to its cycle and timestamp', async () => {
    // R15: red if `aplicar` does not advance the mark: the next older notice would not be held.
    subRepo.findOne.mockResolvedValue(row())
    manager.findOne.mockResolvedValue(row())

    expect(await service.handle(event(charge(3, T0), 'ev-charge'))).toBe('applied')

    expect(savedRow().providerWatermark).toEqual({
      name: NAME,
      cycle: 3,
      at: new Date(T0 * 1000).toISOString(),
    })
  })

  it('scenario 7: a newer notice applied meanwhile makes the older one lose under the lock', async () => {
    // R15: red if `aplicar` does not check the order again on the locked row.
    subRepo.findOne.mockResolvedValue(row())
    const locked = row({
      providerWatermark: { name: NAME, cycle: 3, at: new Date(T0 * 1000).toISOString() },
    })
    manager.findOne.mockResolvedValue(locked)
    const discard = builder()
    manager.createQueryBuilder.mockImplementation((entity?: unknown) =>
      entity ? builder() : discard,
    )

    const outcome = await service.handle(event(statusChange('EXPIRED', T0 - 60), 'ev-old'))

    expect(outcome).toBe('out_of_order')
    expect(manager.save).not.toHaveBeenCalled()
    expect(locked.status).toBe(SubscriptionStatus.ACTIVE)
    expect(discard.set).toHaveBeenCalledWith(expect.objectContaining({ traceStatus: 'discarded' }))
    expect(discard.andWhere).toHaveBeenCalledWith("metadata ->> 'providerEventId' = :pid", {
      pid: 'ev-old',
    })
    // backend-roles already got the downgrade before the lock: that is the residual, and it is logged.
    expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /ev-old lost the order under lock after backend-roles ran: degradar brand=brand-order plan=pro/,
    )
  })

  it('scenario 2 (unit): the pending trace is written before backend-roles is called', async () => {
    // R15: red if the pending trace is written after backend-roles answers.
    subRepo.findOne.mockResolvedValue(row())
    const order: string[] = []
    const insert = builder()
    insert.execute.mockImplementation(async () => order.push('pending trace'))
    eventRepo.createQueryBuilder.mockImplementation(() => insert)
    roles.removePlanFromBrand.mockImplementation(async () => {
      order.push('roles')
      return false
    })

    await expect(service.handle(event(charge(3, T0, 'FAILED'), 'ev-failed'))).rejects.toThrow(
      /backend-roles/,
    )

    expect(order).toEqual(['pending trace', 'roles'])
    expect(insert.orIgnore).toHaveBeenCalled()
    expect(dataSource.transaction).not.toHaveBeenCalled()
  })

  it('the retry turns the pending trace into the applied one instead of adding a row', async () => {
    // R15: red if `aplicar` inserts a new trace while a pending one of the notice exists.
    subRepo.findOne.mockResolvedValue(row())
    manager.findOne.mockResolvedValue(row())
    manager.createQueryBuilder.mockImplementation(() => {
      const b = builder()
      // Only the pending lookup asks for `traceStatus = pending`; the marker asks for `applied`.
      b.andWhere.mockImplementation((sql: string, params: any) => {
        if (params?.pending) b.getOne.mockResolvedValue({ id: 'trace-pending' })
        return b
      })
      return b
    })

    await service.handle(event(charge(3, T0, 'FAILED'), 'ev-retry'))

    const [trace, ...more] = savedTraces()
    expect(more).toHaveLength(0)
    expect(trace.id).toBe('trace-pending')
    expect(trace.traceStatus).toBe('applied')
    expect(trace.metadata.signatureChecksum).toEqual(expect.any(String))
  })
})
