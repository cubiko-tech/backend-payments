/**
 * ROAX Ads gives back tokens of one of its debits over HTTP against PostgreSQL (LOC-187): the
 * reverse order per origin, the cap of the debit, its key, and two refunds racing on two instances.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'

import { WalletStatus } from '../src/wallet/entities/wallet.entity'
import { ACCESS_SERVER, JWT_SECRET } from './support/dropi-recharge.fixture'
import {
  DEBIT_MEMBER_ID,
  DebitApp,
  holdWalletRow,
  movementsOf,
  OTHER_SERVICE_KEY,
  platformMembers,
  postDebit,
  postRefund,
  seedTokenWallet,
  startDebitApp,
  startUpstream,
  Upstream,
  walletState,
} from './support/token-debit.fixture'
import {
  cleanBrand,
  RaceInstance,
  sessionsWaitOnRowLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a1870000-0000-4000-8000-0000000000e1'
const OTHER_BRAND = 'a1870000-0000-4000-8000-0000000000e2'
const NO_WALLET_BRAND = 'a1870000-0000-4000-8000-0000000000e3'
// Keys are unique across the whole table, so each suite running at once has its own.
const DEBIT_KEY = 'loc187-refund-suite-1'

describe('ROAX Ads refunds a token debit (PostgreSQL, LOC-187)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let b: RaceInstance
  let platform: Upstream
  let debitsA: DebitApp
  let debitsB: DebitApp
  let member = ''

  const refund = (overrides: object = {}) => ({
    brandId: BRAND,
    debitKey: DEBIT_KEY,
    tokens: 3,
    refundKey: 'piece-1',
    ...overrides,
  })
  /** Gift 4, purchased 6, Dropi 5 and a debit of 8 under `DEBIT_KEY`: split gift 4, purchased 4. */
  const debited = async (brandId = BRAND, status = WalletStatus.ACTIVE) => {
    const wallet = await seedTokenWallet(a.dataSource, brandId, { gift: 4, purchased: 6, dropi: 5 })
    const res = await postDebit(debitsA, { brandId, tokens: 8, idempotencyKey: DEBIT_KEY }, member)
    expect(res.status).toBe(HttpStatus.CREATED)
    if (status !== WalletStatus.ACTIVE) {
      await a.dataSource.query('UPDATE wallets SET status = $1 WHERE id = $2', [status, wallet.id])
    }
    return { walletId: wallet.id, debitId: res.body.data.debit.id as string }
  }
  const refundsOf = async (walletId: string) =>
    (await movementsOf(a.dataSource, walletId)).filter((m) => m.type === 'credit')

  beforeAll(async () => {
    platform = await startUpstream(platformMembers([BRAND, OTHER_BRAND]))
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER, SERVICE_PLATFORM: platform.url })
    a = await startInstance()
    b = await startInstance()
    debitsA = await startDebitApp(a.dataSource)
    debitsB = await startDebitApp(b.dataSource)
    member = debitsA.jwt.sign({ id: DEBIT_MEMBER_ID, isSuperAdmin: false, brand: BRAND })
  })

  beforeEach(async () => {
    for (const brand of [BRAND, OTHER_BRAND, NO_WALLET_BRAND]) await cleanBrand(a.dataSource, brand)
  })

  afterAll(async () => {
    for (const brand of [BRAND, OTHER_BRAND, NO_WALLET_BRAND]) await cleanBrand(a.dataSource, brand)
    await debitsA?.app.close()
    await debitsB?.app.close()
    await platform?.close()
    await stopInstance(a)
    await stopInstance(b)
    process.env = { ...envSnapshot }
  })

  it('gives 3 of a gift 4 and purchased 4 debit back to purchased and leaves gift as it was', async () => {
    // R15: red when the refund follows the spend order: gift ends at 3 instead of 0.
    const { walletId, debitId } = await debited()

    const res = await postRefund(debitsA, refund())

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data.refund).toMatchObject({
      tokens: 3,
      tokenSplit: { gift: 0, purchased: 3, dropi: 0 },
      replayed: false,
    })
    expect(await walletState(a.dataSource, walletId)).toEqual({
      balance: 10,
      gift: 0,
      purchased: 5,
      dropi: 5,
    })
    const [movement] = await refundsOf(walletId)
    expect(movement).toMatchObject({
      referenceType: 'token_debit_refund',
      referenceId: debitId,
      idempotencyKey: `roax-ads:refund:${DEBIT_KEY}:piece-1`,
    })
    expect(movement.metadata).toMatchObject({ debitId, serviceClient: 'roax-ads' })
  })

  it('gives the rest of the debit back to purchased, then gift, after an earlier refund', async () => {
    // R15: red when earlier refunds are not subtracted per origin: purchased gets 4 again, gift 1.
    const { walletId } = await debited()
    await postRefund(debitsA, refund())

    const rest = await postRefund(debitsA, refund({ tokens: 5, refundKey: 'piece-2' }))

    expect(rest.status).toBe(HttpStatus.CREATED)
    expect(rest.body.data.refund.tokenSplit).toEqual({ gift: 4, purchased: 1, dropi: 0 })
    expect(await walletState(a.dataSource, walletId)).toEqual({
      balance: 15,
      gift: 4,
      purchased: 6,
      dropi: 5,
    })
  })

  it('gives a Dropi debit back to Dropi first', async () => {
    // R15: red when Dropi is not first in the refund order: gift gets 1 of the 2.
    const wallet = await seedTokenWallet(a.dataSource, BRAND, { gift: 1, purchased: 0, dropi: 5 })
    const body = { brandId: BRAND, tokens: 3, idempotencyKey: DEBIT_KEY, inDropi: true }
    expect((await postDebit(debitsA, body, member)).status).toBe(HttpStatus.CREATED)

    const res = await postRefund(debitsA, refund({ tokens: 2 }))

    expect(res.body.data.refund.tokenSplit).toEqual({ gift: 0, purchased: 0, dropi: 2 })
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ gift: 0, dropi: 5 })
  })

  it('refuses with 422 a refund of 6 after 3 of a debit of 8, and moves nothing', async () => {
    // R15: red when the cap ignores earlier refunds: the 6 passes and the brand gets 9 of 8 back.
    const { walletId } = await debited()
    await postRefund(debitsA, refund())

    const res = await postRefund(debitsA, refund({ tokens: 6, refundKey: 'piece-2' }))

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('REFUND_EXCEEDS_DEBIT')
    expect(await refundsOf(walletId)).toHaveLength(1)
    expect(await walletState(a.dataSource, walletId)).toMatchObject({ balance: 10, purchased: 5 })
  })

  it('lets one of two refunds of 8 with different keys on two instances through, the other 422', async () => {
    // R15: red when the cap is read outside the row lock: both pass and the brand gets 16 back.
    const { walletId } = await debited()
    const release = await holdWalletRow(a.dataSource, walletId)
    const racing = Promise.all([
      postRefund(debitsA, refund({ tokens: 8, refundKey: 'piece-a' })),
      postRefund(debitsB, refund({ tokens: 8, refundKey: 'piece-b' })),
    ])
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await release()

    const statuses = (await racing).map((r) => r.status).sort()

    expect(statuses).toEqual([HttpStatus.CREATED, HttpStatus.UNPROCESSABLE_ENTITY])
    expect(await refundsOf(walletId)).toHaveLength(1)
    expect(await walletState(a.dataSource, walletId)).toEqual({
      balance: 15,
      gift: 4,
      purchased: 6,
      dropi: 5,
    })
  })

  it('applies two refunds with the same key on two instances once and answers both with it', async () => {
    // R15: red when the refund key is not derived from the sent one alone: both apply, 6 back.
    const { walletId } = await debited()
    const release = await holdWalletRow(a.dataSource, walletId)
    const racing = Promise.all([postRefund(debitsA, refund()), postRefund(debitsB, refund())])
    expect(await sessionsWaitOnRowLock(a.dataSource, 2)).toBe(true)
    await release()

    const both = await racing

    expect(both.map((r) => r.status).sort()).toEqual([HttpStatus.OK, HttpStatus.CREATED])
    expect(both[0].body.data.refund.id).toBe(both[1].body.data.refund.id)
    expect(await refundsOf(walletId)).toHaveLength(1)
    expect(await walletState(a.dataSource, walletId)).toMatchObject({ balance: 10 })
  })

  it('refuses with 409 the same refund key with other tokens and moves nothing', async () => {
    // R15: red when the replay ignores the amount: the second gets 200 with the 3 refund.
    const { walletId } = await debited()
    await postRefund(debitsA, refund())

    const res = await postRefund(debitsA, refund({ tokens: 1 }))

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(await refundsOf(walletId)).toHaveLength(1)
  })

  it('answers 404 for an unknown debit key, a debit of another brand and a brand without wallet', async () => {
    // R15: red when the debit lookup drops the wallet check: the other brand's debit is refunded.
    const { walletId } = await debited()
    await seedTokenWallet(a.dataSource, OTHER_BRAND, { gift: 0, purchased: 0, dropi: 0 })

    const unknown = await postRefund(debitsA, refund({ debitKey: 'loc187-refund-suite-404' }))
    const otherBrand = await postRefund(debitsA, refund({ brandId: OTHER_BRAND }))
    const noWallet = await postRefund(debitsA, refund({ brandId: NO_WALLET_BRAND }))

    expect([unknown.status, otherBrand.status, noWallet.status]).toEqual([404, 404, 404])
    expect(otherBrand.body.code).toBe('DEBIT_NOT_FOUND')
    expect(await refundsOf(walletId)).toHaveLength(0)
    expect(await walletState(a.dataSource, walletId)).toMatchObject({ balance: 7 })
  })

  it('refunds into a frozen wallet', async () => {
    // R15: red when the refund requires an active wallet: it gets 422.
    const { walletId } = await debited(BRAND, WalletStatus.FROZEN)

    const res = await postRefund(debitsA, refund())

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(await walletState(a.dataSource, walletId)).toMatchObject({ balance: 10, purchased: 5 })
  })

  it('refuses with 422 a refund into a closed wallet and moves nothing', async () => {
    // R15: red when the closed check goes: the closed wallet takes the 3.
    const { walletId } = await debited(BRAND, WalletStatus.CLOSED)

    const res = await postRefund(debitsA, refund())

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('WALLET_CLOSED')
    expect(await refundsOf(walletId)).toHaveLength(0)
  })

  it('refuses with 403 the server token, a user and another service, and moves nothing', async () => {
    // R15: red when the class loses @RequireServiceClient(ROAX_ADS_CLIENT): one of them gets 201.
    const { walletId } = await debited()

    const asServer = await postRefund(debitsA, refund(), ACCESS_SERVER)
    const asUser = await postRefund(debitsA, refund(), member)
    const asOther = await postRefund(debitsA, refund(), OTHER_SERVICE_KEY)

    expect([asServer.status, asUser.status, asOther.status]).toEqual([403, 403, 403])
    expect(await refundsOf(walletId)).toHaveLength(0)
  })

  it.each([
    ['tokens as the exponential form 1e-7', { tokens: 1e-7 }],
    ['tokens as a string', { tokens: '3' }],
    ['tokens as null', { tokens: null }],
    ['tokens as the maximum of transactions.amount', { tokens: 9_999_999_999_999.99 }],
    ['a refund key with the separator', { refundKey: 'piece:1' }],
    ['no debit key', { debitKey: null }],
  ])('refuses %s with 400 and moves nothing', async (_label, overrides) => {
    // R15: red when the DTO loses its rule for this value: the call gets 201, 404 or 500.
    const { walletId } = await debited()

    const res = await postRefund(debitsA, refund(overrides))

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await refundsOf(walletId)).toHaveLength(0)
  })
})
