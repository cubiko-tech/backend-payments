/**
 * A pending recharge from Dropi against PostgreSQL (LOC-174): a retry gets the same one, and no
 * sweep, cancellation or checkout closes it; only its result will (LOC-175).
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'

import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { dropiRechargeKey } from '../src/recharge/dropi-recharge.service'
import { scopeSweepsToBrand } from './support/brand-scoped-sweep'
import {
  ACCESS_SERVER,
  cleanBillingProfile,
  forgetCachedTrm,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  RechargeApp,
  rechargesOf,
  startRechargeApp,
} from './support/dropi-recharge.fixture'
import { startTrmSource, trmDown, trmOk, TrmSource } from './support/trm-source.fixture'
import {
  backdate,
  cleanBrand,
  PLAN_PRICE,
  planCheckout,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const RECHARGE_BRAND = 'a1740000-0000-4000-8000-0000000000e3'
const REQUEST_ID = 'b1740000-0000-4000-8000-000000000002'

describe('A pending recharge from Dropi stays pending (PostgreSQL, LOC-174)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  let recharge: RechargeApp
  let member = ''

  const create = (tokens = 10) =>
    postRecharge(recharge, { brandId: RECHARGE_BRAND, tokens, requestId: REQUEST_ID }, member)
  const clean = async () => {
    await cleanBrand(a.dataSource, RECHARGE_BRAND)
    await cleanBillingProfile(a.dataSource, RECHARGE_BRAND)
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    a = await startInstance()
    scopeSweepsToBrand(a.tasks, RECHARGE_BRAND)
    trm = await startTrmSource()
    recharge = await startRechargeApp(a.dataSource, trm, RECHARGE_BRAND)
    member = recharge.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: RECHARGE_BRAND })
  })

  beforeEach(async () => {
    await clean()
    trm.reply = trmOk
    forgetCachedTrm(recharge)
  })
  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await recharge?.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('a retry with the same requestId gets the same recharge with 200, even with no TRM', async () => {
    // R15: red when the lookup by key goes: the retry prices again and gets 503 from the TRM.
    const first = await create()
    trm.reply = trmDown
    forgetCachedTrm(recharge)

    const retry = await create()

    expect([first.status, retry.status]).toEqual([HttpStatus.CREATED, HttpStatus.OK])
    expect(retry.body.data.id).toBe(first.body.data.id)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(1)
  })

  it('the same requestId with other tokens is refused with 409 and changes nothing', async () => {
    // R15: red when the tokens comparison goes: the retry with 20 tokens gets 200.
    const first = await create(10)
    const other = await create(20)

    expect(other.status).toBe(HttpStatus.CONFLICT)
    const rows = await rechargesOf(a.dataSource, RECHARGE_BRAND)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(first.body.data.amount)
  })

  it('a call that read no recharge before another inserted it gets that one, not a second', async () => {
    // R15: red when the insert loses its unique-violation catch: the late call gets 500.
    const first = await create()
    // Stands for another instance that looked up the key before the first insert committed.
    jest.spyOn(a.dataSource.getRepository(Payment), 'findOne').mockResolvedValueOnce(null)

    const late = await create()

    expect(late.status).toBe(HttpStatus.OK)
    expect(late.body.data.id).toBe(first.body.data.id)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(1)
  })

  it('the expiry sweep 25 hours later leaves it pending and still expires a checkout', async () => {
    // R15: red when the sweep stops excluding dropi_wallet: the recharge ends failed.
    const created = await create()
    const wallet = await seedWallet(a.dataSource, RECHARGE_BRAND)
    const repo = a.dataSource.getRepository(Payment)
    const checkout = await repo.save(
      repo.create({
        ...planCheckout(RECHARGE_BRAND, wallet.id, 'loc174-control', 'dropi-roax'),
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.PENDING,
      } as Partial<Payment>),
    )
    await backdate(a.dataSource, created.body.data.id, '25 hours')
    await backdate(a.dataSource, checkout.id, '25 hours')

    await a.tasks.expirePendingCheckouts()

    expect(await statusOf(a.dataSource, created.body.data.id)).toBe(PaymentStatus.PENDING)
    expect(await statusOf(a.dataSource, checkout.id)).toBe(PaymentStatus.FAILED)
  })

  it('the user cannot cancel it: 422 and it stays pending', async () => {
    // R15: red when the cancel stops excluding dropi_wallet: the recharge ends failed.
    const created = await create()

    await expect(a.payments.cancelPayment(created.body.data.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_CANCELLABLE' },
    })
    expect(await statusOf(a.dataSource, created.body.data.id)).toBe(PaymentStatus.PENDING)
  })

  it('a checkout reusing its key is refused with 409 and leaves it pending', async () => {
    // R15: red when the checkout stops comparing the stored payment: it answers with the recharge.
    const created = await create()
    const wallet = await seedWallet(a.dataSource, RECHARGE_BRAND)

    await expect(
      a.checkout.processCheckout(
        planCheckout(RECHARGE_BRAND, wallet.id, dropiRechargeKey(REQUEST_ID), 'dropi-roax'),
      ),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_CONFLICT' } })
    expect(await statusOf(a.dataSource, created.body.data.id)).toBe(PaymentStatus.PENDING)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(1)
  })
})
