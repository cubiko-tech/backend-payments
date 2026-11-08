/**
 * Two results of one recharge from Dropi at once, against PostgreSQL (LOC-175). The test holds the
 * token wallet row so both calls read the recharge pending before either commits, then lets go.
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
  someoneWaitsOnRowLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const RECHARGE_BRAND = 'a1750000-0000-4000-8000-0000000000e2'
const REQUEST_ID = 'b1750000-0000-4000-8000-000000000002'

describe('Two results of one recharge from Dropi at once (PostgreSQL, LOC-175)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  let recharge: RechargeApp
  let member = ''
  let payment: Payment
  let holder: QueryRunner | undefined

  const result = (status: string, dropiOperationId?: string) => ({
    brandId: RECHARGE_BRAND,
    status,
    amount: Number(payment.amount),
    dropiOperationId,
  })
  // Sent now: a supertest request only starts when something awaits it.
  const send = (body: object) => postResult(recharge, payment.id, body).then((res) => res)
  const holdWallet = async () => {
    holder = a.dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [payment.walletId])
  }
  const holdPayment = async () => {
    holder = a.dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    await holder.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE', [payment.id])
  }
  const closeEvents = () =>
    recharge.apm.events
      .filter((event) => event.type === 'DropiRecharge' && event.attributes.status !== 'pending')
      .map((event) => event.attributes.status)
  const releaseWallet = async () => {
    await holder?.commitTransaction()
    await holder?.release()
    holder = undefined
  }
  const balance = async () => Number((await tokenWalletOf(a.dataSource, RECHARGE_BRAND)).balance)
  const clean = async () => {
    await cleanBrand(a.dataSource, RECHARGE_BRAND)
    await cleanBillingProfile(a.dataSource, RECHARGE_BRAND)
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    a = await startInstance()
    trm = await startTrmSource()
    recharge = await startRechargeApp(a.dataSource, trm, RECHARGE_BRAND)
    member = recharge.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: RECHARGE_BRAND })
  })

  beforeEach(async () => {
    await clean()
    trm.reply = trmOk
    forgetCachedTrm(recharge)
    const created = await postRecharge(
      recharge,
      { brandId: RECHARGE_BRAND, tokens: 10, requestId: REQUEST_ID },
      member,
    )
    payment = await a.dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: created.body.data.id })
    recharge.apm.events.length = 0
  })

  afterEach(async () => {
    if (holder?.isTransactionActive) await holder.rollbackTransaction()
    await holder?.release()
    holder = undefined
  })

  afterAll(async () => {
    await clean()
    await recharge?.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('two charged reports at once credit 10 tokens once and both answer 200', async () => {
    // R15: red when the credit key is per call and the close skips the state: the wallet holds 20.
    await holdWallet()
    const calls = [send(result('charged', 'op-1')), send(result('charged', 'op-1'))]
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await releaseWallet()

    const answers = await Promise.all(calls)

    expect(answers.map((res) => res.status)).toEqual([HttpStatus.OK, HttpStatus.OK])
    expect(answers.map((res) => res.body.data.status)).toEqual(['completed', 'completed'])
    expect(await balance()).toBe(10)
    expect(await creditsOf(a.dataSource, payment.id)).toHaveLength(1)
    expect(await auditOf(a.dataSource, payment.id)).toHaveLength(1)
  })

  it('two charged reports at once with different operation ids: one 200, one 409', async () => {
    // R15: red when a replayed credit answers without deciding again: both get 200.
    await holdWallet()
    const calls = [send(result('charged', 'op-1')), send(result('charged', 'op-2'))]
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await releaseWallet()

    const statuses = (await Promise.all(calls)).map((res) => res.status).sort()

    expect(statuses).toEqual([HttpStatus.OK, HttpStatus.CONFLICT])
    expect(await balance()).toBe(10)
    expect(await creditsOf(a.dataSource, payment.id)).toHaveLength(1)
  })

  it('two charged reports at once leave a single close event, from the call that closed it', async () => {
    // R15: red when the overtaken charged call also signals its close: two charged events.
    await holdWallet()
    const calls = [send(result('charged', 'op-1')), send(result('charged', 'op-2'))]
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await releaseWallet()

    const statuses = (await Promise.all(calls)).map((res) => res.status).sort()

    expect(statuses).toEqual([HttpStatus.OK, HttpStatus.CONFLICT])
    expect(closeEvents()).toEqual(['charged'])
  })

  it('a charged report overtaken by a failed one leaves only the failed close event', async () => {
    // R15: red when the charged call closed meanwhile signals anyway: a charged event appears.
    await holdWallet()
    const late = send(result('charged', 'op-1'))
    expect(await someoneWaitsOnRowLock(a.dataSource)).toBe(true)

    const first = await send(result('failed'))
    await releaseWallet()
    const second = await late

    expect([first.status, second.status]).toEqual([HttpStatus.OK, HttpStatus.CONFLICT])
    expect(closeEvents()).toEqual(['failed'])
  })

  it('a failed report overtaken by a charged one gets 409 and leaves only the charged event', async () => {
    // R15: red when the failed call that found it closed signals anyway: a failed event appears.
    await holdPayment()
    const charged = send(result('charged', 'op-1'))
    expect(await someoneWaitsOnRowLock(a.dataSource)).toBe(true)
    const failed = send(result('failed'))
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await releaseWallet()

    const answers = await Promise.all([charged, failed])

    expect(answers.map((res) => res.status)).toEqual([HttpStatus.OK, HttpStatus.CONFLICT])
    const stored = await a.dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })
    expect(stored.status).toBe(PaymentStatus.COMPLETED)
    expect(closeEvents()).toEqual(['charged'])
  })

  it('a charged report overtaken by a failed one gets 409 and its credit is rolled back', async () => {
    // R15: red when the close drops `status = pending`: the failed recharge ends completed with 10.
    await holdWallet()
    const late = send(result('charged', 'op-1'))
    expect(await someoneWaitsOnRowLock(a.dataSource)).toBe(true)

    const first = await send(result('failed'))
    await releaseWallet()
    const second = await late

    expect([first.status, second.status]).toEqual([HttpStatus.OK, HttpStatus.CONFLICT])
    const stored = await a.dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })
    expect(stored.status).toBe(PaymentStatus.FAILED)
    expect(await balance()).toBe(0)
    expect(await creditsOf(a.dataSource, payment.id)).toHaveLength(0)
  })
})
