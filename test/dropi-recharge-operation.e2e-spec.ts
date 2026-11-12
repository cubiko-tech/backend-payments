/**
 * One Dropi operation closes one recharge, against PostgreSQL (LOC-182): the unique index on the
 * operation a charged recharge keeps answers 409 to a second recharge reported with it, which stays
 * pending with no credit. At once in one brand the token wallet lock orders the two calls; across two
 * brands there is no shared lock, and only the index holds.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'
import { QueryRunner } from 'typeorm'

import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import {
  ACCESS_SERVER,
  auditOf,
  cleanBillingProfile,
  creditsOf,
  forgetCachedTrm,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  postResult,
  RechargeApp,
  startRechargeApp,
  tokenWalletOf,
} from './support/dropi-recharge.fixture'
import { startTrmSource, trmOk, TrmSource } from './support/trm-source.fixture'
import {
  cleanBrand,
  RaceInstance,
  sessionsWaitOnRowLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a1820000-0000-4000-8000-0000000000e1'
const OTHER_BRAND = 'a1820000-0000-4000-8000-0000000000e2'
const OPERATION = 'op-loc182-1'

describe('One Dropi operation closes one recharge (PostgreSQL, LOC-182)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  const apps: Record<string, RechargeApp> = {}
  let holder: QueryRunner | undefined
  let requests = 0

  const open = async (brandId: string): Promise<Payment> => {
    const app = apps[brandId]
    const member = app.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: brandId })
    requests += 1
    const requestId = `b1820000-0000-4000-8000-${String(requests).padStart(12, '0')}`
    const created = await postRecharge(app, { brandId, tokens: 10, requestId }, member)
    expect(created.status).toBe(HttpStatus.CREATED)
    return a.dataSource.getRepository(Payment).findOneByOrFail({ id: created.body.data.id })
  }
  // Sent now: a supertest request only starts when something awaits it.
  const charge = (payment: Payment) =>
    postResult(apps[payment.brandId], payment.id, {
      brandId: payment.brandId,
      status: 'charged',
      amount: Number(payment.amount),
      dropiOperationId: OPERATION,
    }).then((res) => res)
  const stored = (payment: Payment) =>
    a.dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })
  const expectCharged = async (payment: Payment) => {
    const row = await stored(payment)
    expect([row.status, row.providerPaymentId]).toEqual([PaymentStatus.COMPLETED, OPERATION])
    expect(await creditsOf(a.dataSource, payment.id)).toHaveLength(1)
    expect(await auditOf(a.dataSource, payment.id)).toHaveLength(1)
  }
  const expectRefused = async (
    answer: { status: number; body: { code?: string } },
    payment: Payment,
  ) => {
    expect([answer.status, answer.body.code]).toEqual([
      HttpStatus.CONFLICT,
      'DROPI_OPERATION_ALREADY_USED',
    ])
    const row = await stored(payment)
    expect([row.status, row.providerPaymentId]).toEqual([PaymentStatus.PENDING, null])
    expect(await creditsOf(a.dataSource, payment.id)).toHaveLength(0)
    expect(await auditOf(a.dataSource, payment.id)).toHaveLength(0)
  }
  /** The answers of two calls at once, winner first: which one wins is up to PostgreSQL. */
  const byOutcome = <T extends { status: number }>(pairs: [Payment, T][]) =>
    [...pairs].sort(([, x], [, y]) => x.status - y.status)
  const dropiTokens = async (brandId: string) =>
    Number((await tokenWalletOf(a.dataSource, brandId)).dropiTokens)
  const holdWallets = async (...walletIds: string[]) => {
    holder = a.dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    await holder.query('SELECT 1 FROM wallets WHERE id = ANY($1) FOR UPDATE', [walletIds])
  }
  const releaseWallets = async () => {
    await holder?.commitTransaction()
    await holder?.release()
    holder = undefined
  }
  const clean = async () => {
    for (const brandId of [BRAND, OTHER_BRAND]) {
      await cleanBrand(a.dataSource, brandId)
      await cleanBillingProfile(a.dataSource, brandId)
    }
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    a = await startInstance()
    trm = await startTrmSource()
    // One app per brand: the membership double admits its member to one brand only.
    for (const brandId of [BRAND, OTHER_BRAND]) {
      apps[brandId] = await startRechargeApp(a.dataSource, trm, brandId)
    }
  })

  beforeEach(async () => {
    await clean()
    trm.reply = trmOk
    for (const app of Object.values(apps)) forgetCachedTrm(app)
  })

  afterEach(async () => {
    if (holder?.isTransactionActive) await holder.rollbackTransaction()
    await holder?.release()
    holder = undefined
  })

  afterAll(async () => {
    await clean()
    for (const app of Object.values(apps)) await app.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('CA2: the operation that charged one recharge answers 409 on another, also on its retry', async () => {
    // R15: red when the 23505 of the index is not told apart: the second gets IDEMPOTENCY_KEY_CONFLICT.
    const first = await open(BRAND)
    const second = await open(BRAND)

    const answers = [await charge(first), await charge(second)]
    const retry = await charge(second)

    expect(answers[0].status).toBe(HttpStatus.OK)
    await expectCharged(first)
    await expectRefused(answers[1], second)
    // The 409 rolled the credit back: the retry finds no movement under its key and is refused again.
    await expectRefused(retry, second)
    expect(await dropiTokens(BRAND)).toBe(10)
  })

  it('CA2: two recharges of one brand charged at once with one operation credit 10 tokens', async () => {
    // R15: red when the unique index is dropped: both close and the dropi origin holds 20.
    const first = await open(BRAND)
    const second = await open(BRAND)
    await holdWallets(first.walletId)
    const calls = [charge(first), charge(second)]
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await releaseWallets()

    const answers = await Promise.all(calls)

    expect(await dropiTokens(BRAND)).toBe(10)
    const [[winner, won], [loser, lost]] = byOutcome([
      [first, answers[0]],
      [second, answers[1]],
    ])
    expect(won.status).toBe(HttpStatus.OK)
    await expectCharged(winner)
    await expectRefused(lost, loser)
  })

  it('CA2: recharges of two brands charged at once with one operation credit 10 tokens in all', async () => {
    // R15: red when the index is per (brandId, providerPaymentId): each brand gets 10, 20 in all.
    const first = await open(BRAND)
    const second = await open(OTHER_BRAND)
    await holdWallets(first.walletId, second.walletId)
    const calls = [charge(first), charge(second)]
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await releaseWallets()

    const answers = await Promise.all(calls)

    expect((await dropiTokens(BRAND)) + (await dropiTokens(OTHER_BRAND))).toBe(10)
    const [[winner, won], [loser, lost]] = byOutcome([
      [first, answers[0]],
      [second, answers[1]],
    ])
    expect(won.status).toBe(HttpStatus.OK)
    await expectCharged(winner)
    await expectRefused(lost, loser)
  })
})
