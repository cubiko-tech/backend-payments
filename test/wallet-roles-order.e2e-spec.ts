import { Subscription } from '../src/subscription/entities/subscription.entity'
import {
  cleanBrand,
  createGate,
  planCheckout,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7100003-2222-4333-8444-555555555555'
const BALANCE = 100000

describe('Roles calls of two wallet closes arriving out of order (PostgreSQL, LOC-100)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => {
    a.assignPlan.mockReset().mockResolvedValue(true)
    b.assignPlan.mockReset().mockResolvedValue(true)
  })

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
    await stopInstance(b)
  })

  /**
   * The first close's roles call lands after the second close's, and returns the writes in
   * the order backend-roles received them.
   */
  const raceRoles = async (firstPlan: string, secondPlan: string, prefix: string) => {
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const writes: { plan: string; expiresAt: Date }[] = []
    const record = (_brand: string, plan: string, expiresAt: Date) => {
      writes.push({ plan, expiresAt })
      return Promise.resolve(true)
    }
    const gate = createGate()
    // R17: backend-roles is HTTP; this double fixes the order its two calls land in.
    a.assignPlan.mockImplementationOnce(async (brand: string, plan: string, expiresAt: Date) => {
      gate.arrive()
      await gate.wait
      return record(brand, plan, expiresAt)
    })
    a.assignPlan.mockImplementation(record)
    b.assignPlan.mockImplementation(record)

    const first = a.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, `${prefix}-a`, firstPlan),
    )
    await gate.reached
    await b.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, `${prefix}-b`, secondPlan))
    gate.release()
    await first

    const sub = await a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })
    return { writes, sub: sub! }
  }

  it('ends with the plan the subscription has, when the two are of different plans', async () => {
    // R15: red without the re-read in assignCurrentPlanInRoles: the last write is the old plan.
    const { writes, sub } = await raceRoles('dropi-roax', 'dropi-roax-plus', 'plans')

    expect(sub.planSlug).toBe('dropi-roax-plus')
    expect(writes.map((write) => write.plan)).toEqual([
      'dropi-roax-plus',
      'dropi-roax',
      'dropi-roax-plus',
    ])
  })

  it('ends with the period the subscription has, when the two are of one plan', async () => {
    // R15: red if the re-read compares only the plan: the last write keeps the shorter period.
    const { writes, sub } = await raceRoles('dropi-roax', 'dropi-roax', 'period')

    const last = writes[writes.length - 1]
    expect(last.plan).toBe('dropi-roax')
    expect(new Date(last.expiresAt).getTime()).toBe(new Date(sub.currentPeriodEnd).getTime())
    expect(writes).toHaveLength(3)
  })
})
