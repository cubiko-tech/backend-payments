import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import {
  PaymentsListQueryDto,
  SubscriptionsListQueryDto,
  WalletsListQueryDto,
} from './admin-list-query.dto'

const BRAND_A = 'a3110001-0000-4000-8000-000000000001'
const BRAND_B = 'a3110002-0000-4000-8000-000000000002'

// Same options as the global pipe: whitelist and forbidNonWhitelisted turn unknown params into errors.
const check = async <T extends object>(dto: new () => T, query: Record<string, unknown>) => {
  const instance = plainToInstance(dto, query)
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true })
  return { instance, failed: errors.map((error) => error.property) }
}

describe('Admin list query DTOs (LOC-311)', () => {
  it('accepts every parameter the admin finance wallets page sends', async () => {
    // Mutation: drop `search` from the wallets DTO and forbidNonWhitelisted reports it.
    const { failed } = await check(WalletsListQueryDto, {
      page: '1',
      perPage: '20',
      orderBy: 'createdAt',
      order: 'DESC',
      status: 'active',
      provider: 'internal',
      search: 'acme',
      brandIds: `${BRAND_A},${BRAND_B}`,
    })

    expect(failed).toEqual([])
  })

  it('accepts the processes whitelist on subscriptions', async () => {
    // Mutation: drop `planSlug` from the subscriptions DTO and it is reported as not allowed.
    const { failed } = await check(SubscriptionsListQueryDto, {
      page: '2',
      status: 'active',
      planSlug: 'pro',
      orderBy: 'currentPeriodEnd',
      order: 'asc',
      perPage: '100',
    })

    expect(failed).toEqual([])
  })

  it('accepts every parameter the admin finance payments page sends', async () => {
    // Mutation: drop `purpose` from the payments DTO and it is reported as not allowed.
    const { failed } = await check(PaymentsListQueryDto, {
      page: '1',
      perPage: '20',
      orderBy: 'createdAt',
      order: 'DESC',
      status: 'completed',
      provider: 'stripe',
      purpose: 'plan_purchase',
      search: 'pay',
    })

    expect(failed).toEqual([])
  })

  it.each([['1e-7'], ['abc'], ['null'], ['1.5'], ['0'], ['101']])(
    'rejects perPage=%s',
    async (perPage) => {
      // Mutation: drop @IsInt or @Max(100) from perPage and the matching value passes.
      const { failed } = await check(WalletsListQueryDto, { perPage })

      expect(failed).toEqual(['perPage'])
    },
  )

  it('rejects a page above its cap', async () => {
    // Mutation: drop @Max(MAX_LIST_PAGE) from page and 100001 passes.
    const { failed } = await check(PaymentsListQueryDto, { page: '100001' })

    expect(failed).toEqual(['page'])
  })

  it('rejects a status outside its enum on each list', async () => {
    // Mutation: replace @IsEnum with @IsString on any of the three status fields and it passes.
    const dtos: (new () => object)[] = [
      WalletsListQueryDto,
      SubscriptionsListQueryDto,
      PaymentsListQueryDto,
    ]
    for (const dto of dtos) {
      const { failed } = await check(dto, { status: 'no-existe' })
      expect(failed).toEqual(['status'])
    }
  })

  it('reads a blank filter as absent, as the handlers did before the DTOs', async () => {
    // Mutation: return the value unchanged in blankAsAbsent and status= fails @IsEnum.
    const { instance, failed } = await check(WalletsListQueryDto, { status: '', page: '' })

    expect(failed).toEqual([])
    expect(instance.status).toBeUndefined()
    expect(instance.page).toBeUndefined()
  })

  it('uppercases the currency and keeps the three-character shape of wallet creation', async () => {
    // Mutation: drop the toUpperCase in toUpper and the instance keeps `tkn`.
    const lower = await check(WalletsListQueryDto, { currency: 'tkn' })
    expect(lower.failed).toEqual([])
    expect(lower.instance.currency).toBe('TKN')

    for (const currency of ['TK', 'TKNN']) {
      const { failed } = await check(WalletsListQueryDto, { currency })
      expect(failed).toEqual(['currency'])
    }
  })

  it('splits brandIds on commas and on repeated params', async () => {
    // Mutation: stop splitting on commas in toBrandIdList and `a,b` becomes one invalid id.
    const joined = await check(WalletsListQueryDto, { brandIds: `${BRAND_A}, ${BRAND_B}` })
    expect(joined.failed).toEqual([])
    expect(joined.instance.brandIds).toEqual([BRAND_A, BRAND_B])

    const repeated = await check(WalletsListQueryDto, { brandIds: [BRAND_A, BRAND_B] })
    expect(repeated.instance.brandIds).toEqual([BRAND_A, BRAND_B])
  })

  it.each([
    ['a non-UUID', 'no-uuid'],
    ['an empty list', ''],
    ['only commas', ',,'],
  ])('rejects brandIds with %s', async (_label, brandIds) => {
    // Mutation: drop @IsUUID (non-UUID) or @ArrayMinSize(1) (empty lists) and the value passes.
    const { failed } = await check(WalletsListQueryDto, { brandIds })

    expect(failed).toEqual(['brandIds'])
  })

  it('rejects more than 100 brandIds', async () => {
    // Mutation: drop @ArrayMaxSize(MAX_LIST_BRAND_IDS) and 101 ids pass.
    const ids = Array.from(
      { length: 101 },
      (_, i) => `a3110000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    )
    const { failed } = await check(WalletsListQueryDto, { brandIds: ids.join(',') })

    expect(failed).toEqual(['brandIds'])
  })
})
