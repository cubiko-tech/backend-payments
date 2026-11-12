/**
 * AdminController through the production global pipe: the extension body is validated before
 * anything is read or written, and numeric query params reach the handlers as numbers.
 */
import { Controller, Get, INestApplication, Query } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'

import { AuditService } from '../audit/audit.service'
import { CreditService } from '../credit/credit.service'
import { Payment } from '../payment/entities/payment.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../wallet/wallet.service'
import { AdminController } from './admin.controller'

const SUB_ID = '11111111-1111-4111-8111-111111111111'
const DAY_MS = 24 * 60 * 60 * 1000

@Controller('probe')
class QueryProbeController {
  @Get()
  probe(@Query('perPage') perPage?: number) {
    return { perPage }
  }
}

// R17: these cases check what reaches the handler; no query runs, so a repository double suffices.
const repo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  save: jest.fn((row: unknown) => Promise.resolve(row)),
})

describe('AdminController body and query conversion through the global pipe', () => {
  let app: INestApplication
  let subscriptionReadRepo: ReturnType<typeof repo>
  let subscriptionWriteRepo: ReturnType<typeof repo>
  let auditService: { log: jest.Mock }

  beforeAll(async () => {
    subscriptionReadRepo = repo()
    subscriptionWriteRepo = repo()
    // R17: the audit trail is not under test; the double only records that nothing was logged.
    auditService = { log: jest.fn().mockResolvedValue(undefined) }
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController, QueryProbeController],
      providers: [
        { provide: getRepositoryToken(Subscription, 'DBRead'), useValue: subscriptionReadRepo },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subscriptionWriteRepo },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: repo() },
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: repo() },
        { provide: getRepositoryToken(Wallet, 'DBRead'), useValue: repo() },
        { provide: getRepositoryToken(Wallet, 'DBWrite'), useValue: repo() },
        { provide: getRepositoryToken(WalletBalanceSnapshot, 'DBRead'), useValue: repo() },
        { provide: getRepositoryToken(ProviderConfig, 'DBRead'), useValue: repo() },
        { provide: getRepositoryToken(ProviderConfig, 'DBWrite'), useValue: repo() },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: repo() },
        { provide: AuditService, useValue: auditService },
        { provide: CreditService, useValue: {} },
        { provide: WalletService, useValue: {} },
      ],
    })
      // R17: operator authorization is covered by admin.controller.spec; here it only has to pass.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    subscriptionWriteRepo.findOne.mockResolvedValue({
      id: SUB_ID,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      nextBillingDate: new Date('2026-09-01T00:00:00.000Z'),
      accessEndsAt: null,
      retryCount: 0,
    })
  })

  const extend = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/admin/subscriptions/${SUB_ID}/extend`).send(body)

  const expectNothingTouched = () => {
    expect(subscriptionWriteRepo.findOne).not.toHaveBeenCalled()
    expect(subscriptionWriteRepo.save).not.toHaveBeenCalled()
    expect(auditService.log).not.toHaveBeenCalled()
  }

  it('rejects days -99999 with 400 INVALID_REQUEST before reading or writing', async () => {
    // R15 (Mutation): dropping @Min(1) lets the handler move the period back centuries.
    const res = await extend({ days: -99999 })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_REQUEST')
    expectNothingTouched()
  })

  it('rejects days "abc" before reading or writing', async () => {
    // R15 (Mutation): the handler back on the inline `{ days: number }` type lets the string through.
    const res = await extend({ days: 'abc' })

    expect(res.status).toBe(400)
    expectNothingTouched()
  })

  it.each([366, 1.5])('rejects days %s', async (days) => {
    // R15 (Mutation): dropping @Max(365) lets 366 through; dropping @IsInt lets 1.5 through.
    const res = await extend({ days })

    expect(res.status).toBe(400)
    expectNothingTouched()
  })

  it.each([
    [7, '2026-09-08T00:00:00.000Z'],
    [365, '2027-09-01T00:00:00.000Z'],
  ])('extends by %s days, as the admin panel sends it', async (days, expectedEnd) => {
    // R15 (Mutation): @Min(8) instead of @Min(1) rejects the panel's default of 7.
    const res = await extend({ days })

    expect(res.status).toBe(201)
    expect(res.body.data.currentPeriodEnd).toBe(expectedEnd)
    expect(subscriptionWriteRepo.save).toHaveBeenCalledTimes(1)
  })

  it('hands perPage=5 to the handler as the number 5', async () => {
    // R15 (Mutation): removing transform from the global pipe hands over the string "5".
    const res = await request(app.getHttpServer()).get('/probe?perPage=5')

    expect(res.body).toStrictEqual({ perPage: 5 })
  })

  const expiringWindowDays = async (query: string) => {
    const before = Date.now()
    await request(app.getHttpServer()).get(`/admin/subscriptions/expiring${query}`).expect(200)
    const { currentPeriodEnd } = subscriptionReadRepo.find.mock.calls[0][0].where
    const [, end] = currentPeriodEnd.value as [Date, Date]
    return (end.getTime() - before) / DAY_MS
  }

  it('builds a 5-day expiring window for days=5', async () => {
    // R15 (Mutation): without transform, getDate() + "5" concatenates and the window spans weeks.
    expect(Math.round(await expiringWindowDays('?days=5'))).toBe(5)
  })

  it('keeps the 7-day default when days is absent and arrives as NaN', async () => {
    // R15 (Mutation): `days ?? 7` in subscriptionsExpiring keeps NaN and breaks the window.
    expect(Math.round(await expiringWindowDays(''))).toBe(7)
  })
})
