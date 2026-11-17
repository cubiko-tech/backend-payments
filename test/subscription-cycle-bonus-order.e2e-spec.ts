import { INestApplication, Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { ClientPlatformService } from '../src/client/client-platform.service'
import { buildConfioWebhookEventId } from '../src/provider/confio/confio-webhook'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionController } from '../src/subscription/subscription.controller'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { signatureChecksumDigest } from '../src/webhook/confio-traza.util'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import { SubscriptionBonusService } from '../src/webhook/subscription-bonus.service'
import {
  answerAsRoles,
  BonusChain,
  bonusesOf,
  catalog,
  cleanBonusBrand,
  deliver,
  eventsOf,
  post,
  ROLES_URL,
  seedConfioSubscription,
  signedCharge,
  startBonusChain,
  subName,
  tokenWalletOf,
  WEBHOOK_KEY,
} from './support/subscription-bonus.fixture'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

const BRAND_A = 'b2350235-1111-4333-8444-555555555235'
const NEW_SIGNUP = `${subName(BRAND_A)}-renewed`

type Charge = ReturnType<typeof signedCharge>

/** The same signed notice with one digit moved from `amountCents` to `cycleNumber`: same checksum. */
const shifted = (charge: Charge): Charge => {
  const data = { ...charge.data }
  data.cycleNumber = Number(`${data.cycleNumber}${String(data.amountCents)[0]}`)
  data.amountCents = Number(String(data.amountCents).slice(1))
  return { ...charge, data, signature: { ...charge.signature } }
}

/** Waits until the stored notice with exactly this payload's event id has been handled. */
async function handled(ds: DataSource, charge: Charge) {
  const providerEventId = buildConfioWebhookEventId(charge as any)
  const deadline = Date.now() + 5000
  let row: WebhookEvent | null = null
  while (Date.now() < deadline) {
    row = await ds.getRepository(WebhookEvent).findOneBy({ provider: 'confio', providerEventId })
    if (row && row.status !== WebhookStatus.RECEIVED && row.status !== WebhookStatus.PROCESSING) {
      return row
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Notice ${providerEventId} did not settle: ${row?.status}`)
}

/** Posts a signed notice over HTTP and returns its stored row once handled. */
async function send(chain: BonusChain, charge: Charge) {
  expect(await post(chain, charge)).toBe(200)
  return handled(chain.dataSource, charge)
}

/** The bonus refusals logged by the bonus service. */
const refusals = (warn: jest.SpyInstance) =>
  warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('skipped for'))

/** Cycle bonus order and identity: only a new cycle of the locked subscription credits (LOC-235). */
describe('Subscription cycle bonus order (PostgreSQL, LOC-235)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let chain: BonusChain
  let other: BonusChain
  let historyApp: INestApplication
  let subscriptions: SubscriptionService
  const originalEnv = process.env

  beforeAll(async () => {
    process.env = { ...originalEnv, CONFIO_WEBHOOK_KEY: WEBHOOK_KEY, SERVICE_ROLES: ROLES_URL }
    a = await startInstance()
    b = await startInstance()
    chain = await startBonusChain(a)
    other = await startBonusChain(b)
    const ds = a.dataSource
    // R17: ConfioPagos is external; a new paid signup answers a new Confio subscription.
    const confioTrial = {
      createForTrial: jest.fn().mockResolvedValue({
        providerSubscriptionId: NEW_SIGNUP,
        status: 'PENDING_ACCEPTANCE',
        acceptanceUrl: 'https://confio.test/accept',
      }),
    }
    // R17: startPaid reaches neither the event bus nor the cancellation or webhook collaborators.
    subscriptions = new SubscriptionService(
      ds.getRepository(Subscription),
      ds.getRepository(Subscription),
      ds.getRepository(SubscriptionEvent),
      ds.getRepository(SubscriptionEvent),
      ds,
      {} as any,
      confioTrial as any,
      {} as any,
      {} as any,
    )
    const historyMod = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        { provide: SubscriptionService, useValue: subscriptions },
        // R17: Only GET /subscription/history runs here; enterprise pricing is not called.
        { provide: EnterprisePricingService, useValue: {} },
        // R17: Platform is another service; the brand member can view its brand's history.
        {
          provide: ClientPlatformService,
          useValue: { canViewBrandCredit: () => Promise.resolve(true) },
        },
      ],
    })
      // R17: Authenticates a brand member so GET /subscription/history runs assertBrandAccess.
      .overrideGuard(ApiAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'member-235' }
          return true
        },
      })
      .compile()
    historyApp = historyMod.createNestApplication()
    await historyApp.init()
  })

  beforeEach(async () => {
    await cleanBonusBrand(a.dataSource, BRAND_A)
    catalog.plans = { 'pro-500': 500, 'pro-700': 700 }
    catalog.down = false
    chain.roles.invalidateCache()
    other.roles.invalidateCache()
    answerAsRoles()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      if (a) await cleanBonusBrand(a.dataSource, BRAND_A)
    } finally {
      await historyApp?.close()
      await chain?.app.close()
      await other?.app.close()
      await stopInstance(a)
      await stopInstance(b)
      process.env = originalEnv
    }
  })

  const ds = () => a.dataSource
  const balance = async () => Number((await tokenWalletOf(ds(), BRAND_A))?.balance ?? 0)

  it('shifted cycle: a signed 1/1990000 resent as 11/990000 is accepted and credits one bonus', async () => {
    // R15: red if the applied-checksum row is dropped: cycle 11 is after 1 and credits again.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    const warn = jest.spyOn(Logger.prototype, 'warn')
    const original = signedCharge(BRAND_A, 'SUCCEEDED', 1)
    await send(chain, original)

    const forged = await send(chain, shifted(original))

    expect(forged.status).toBe(WebhookStatus.PROCESSED)
    const bonuses = await bonusesOf(ds(), BRAND_A)
    expect(bonuses).toHaveLength(1)
    expect(bonuses[0].metadata).toMatchObject({ cycleNumber: 1 })
    expect(await balance()).toBe(500)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(2)
    expect(refusals(warn)).toEqual([
      expect.stringContaining('checksum of an already applied notice'),
    ])
  })

  it('GET /subscription/history after a paid charge does not expose the signed checksum', async () => {
    // R15: red if the movement trace stores the raw signed checksum instead of its digest.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    const original = signedCharge(BRAND_A, 'SUCCEEDED', 1)
    await send(chain, original)

    const res = await request(historyApp.getHttpServer())
      .get('/subscription/history')
      .query({ brandId: BRAND_A })

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain(
      original.signature.checksum.toLowerCase(),
    )
    expect(res.body.data[0].metadata.signatureChecksum).toBe(
      signatureChecksumDigest(original.signature.checksum),
    )
  })

  it('shifted cycle of a charge that gave no bonus still credits nothing', async () => {
    // R15: red if the checksum is looked up among bonuses instead of every applied charge.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    catalog.plans['pro-500'] = 0
    const original = signedCharge(BRAND_A, 'SUCCEEDED', 1)
    await send(chain, original)
    catalog.plans['pro-500'] = 500
    chain.roles.invalidateCache()

    await send(chain, shifted(original))

    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(0)
    expect(await balance()).toBe(0)
  })

  it('new cycle: cycle 2 after cycle 1 credits a second bonus, once', async () => {
    // R15: red if any bonified cycle refuses the next one instead of only cycles not after it.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc235-payment-1')

    await deliver(chain, BRAND_A, 'SUCCEEDED', 2, 'loc235-payment-2')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 2, 'loc235-payment-3')

    const cycles = (await bonusesOf(ds(), BRAND_A)).map((t) => t.metadata.cycleNumber).sort()
    expect(cycles).toEqual([1, 2])
    expect(await balance()).toBe(1000)
  })

  it('old cycle: cycle 1 after cycle 2 credits nothing and is logged', async () => {
    // R15: red if the last-cycle row is dropped: cycle 1 has its own key and credits.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    const warn = jest.spyOn(Logger.prototype, 'warn')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 2, 'loc235-payment-2')

    const late = await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc235-payment-1')

    expect(late.status).toBe(WebhookStatus.PROCESSED)
    const bonuses = await bonusesOf(ds(), BRAND_A)
    expect(bonuses.map((t) => t.metadata.cycleNumber)).toEqual([2])
    expect(await balance()).toBe(500)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(2)
    expect(refusals(warn)).toEqual([
      expect.stringContaining('cycle 1 not after the last bonified cycle 2'),
    ])
  })

  it('changed row: a paid signup reusing the pending row between plan and lock credits nothing', async () => {
    // R15: red if the locked row's plan and Confio subscription stop being compared with the plan.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    await ds().getRepository(Subscription).update(sub.id, { status: SubscriptionStatus.PENDING })
    const warn = jest.spyOn(Logger.prototype, 'warn')
    const roles = answerAsRoles()
    const answer = roles.getMockImplementation()
    let reused = false
    // The plan move to roles runs after `plan()` and before the locked transaction of `aplicar`.
    roles.mockImplementation(async (url, init) => {
      if (!reused && String(url) !== `${ROLES_URL}/v1/plan`) {
        reused = true
        await subscriptions.startPaid({ brandId: BRAND_A, userId: sub.userId, planSlug: 'pro-700' })
      }
      return answer(url, init)
    })

    const notice = await deliver(chain, BRAND_A, 'SUCCEEDED', 1)

    expect(reused).toBe(true)
    expect(notice.status).toBe(WebhookStatus.PROCESSED)
    const row = await ds().getRepository(Subscription).findOneByOrFail({ id: sub.id })
    expect(row).toMatchObject({ planSlug: 'pro-700', providerSubscriptionId: NEW_SIGNUP })
    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(0)
    expect(await balance()).toBe(0)
    expect(refusals(warn)).toEqual([
      expect.stringContaining('subscription changed between planning and the lock'),
    ])
  })

  it('new signup on the same row: its cycle 1 credits after the old subscription reached cycle 2', async () => {
    // R15: red if the last bonified cycle is read for the row without its Confio subscription.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc235-payment-1')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 2, 'loc235-payment-2')
    // The expiry cron ends a subscription; a new paid signup then reuses its row.
    await ds().getRepository(Subscription).update(sub.id, { status: SubscriptionStatus.EXPIRED })
    await subscriptions.startPaid({ brandId: BRAND_A, userId: sub.userId, planSlug: 'pro-500' })
    const first = signedCharge(BRAND_A, 'SUCCEEDED', 1, 'loc235-renewed-1')
    first.data.name = NEW_SIGNUP

    await chain.confio.handle({
      payload: first,
      providerEventId: buildConfioWebhookEventId(first as any),
    } as WebhookEvent)

    const bonuses = await bonusesOf(ds(), BRAND_A)
    expect(bonuses.map((t) => t.idempotencyKey).sort()).toEqual([
      `subscription-bonus:${sub.id}:${NEW_SIGNUP}:ciclo-1`,
      `subscription-bonus:${sub.id}:${subName(BRAND_A)}:ciclo-1`,
      `subscription-bonus:${sub.id}:${subName(BRAND_A)}:ciclo-2`,
    ])
    expect(await balance()).toBe(1500)
  })

  it('a new cycle and its shifted copy handled by two instances at once credit once', async () => {
    // R15: red if neither the row lock nor the wallet lock serializes the reads: no copy sees a checksum.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc235-payment-1')
    const second = signedCharge(BRAND_A, 'SUCCEEDED', 2, 'loc235-payment-2')
    const copy = shifted(second)
    const notice = (charge: Charge) =>
      ({
        payload: charge,
        providerEventId: buildConfioWebhookEventId(charge as any),
      }) as WebhookEvent
    const credit = SubscriptionBonusService.prototype.credit
    let arrived = 0
    let release: () => void
    const both = new Promise<void>((resolve) => (release = resolve))
    // R17: a barrier, not a double: each real credit waits for the other (500 ms at most) to overlap.
    jest.spyOn(SubscriptionBonusService.prototype, 'credit').mockImplementation(async function (
      ...args
    ) {
      if (++arrived === 2) release()
      await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 500))])
      return credit.apply(this, args)
    })

    await Promise.all([chain.confio.handle(notice(second)), other.confio.handle(notice(copy))])

    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(2)
    expect(await balance()).toBe(1000)
  })
})
