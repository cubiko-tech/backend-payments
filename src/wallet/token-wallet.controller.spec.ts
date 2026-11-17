import { HttpStatus } from '@nestjs/common'
import { TokenWalletController } from './token-wallet.controller'

const BRAND_A = 'a1320000-0000-4000-8000-00000000000a'
const BRAND_B = 'a1320000-0000-4000-8000-00000000000b'
const MEMBER_OF_B = { user: { id: 'member-of-b' } }

describe('TokenWalletController (CA1, LOC-132)', () => {
  const build = () => {
    // R17: backend-platform is a remote service; this double answers only for the member's own brand.
    const platformClient = {
      canViewBrandCredit: jest.fn(
        async (userId: string, brandId: string) => userId === 'member-of-b' && brandId === BRAND_B,
      ),
    }
    // R17: the wallet store is tested on PostgreSQL in test/token-wallet.e2e-spec.ts.
    const tokenWallets = {
      getOrCreate: jest.fn(async (brandId: string) => ({ id: 'w', brandId })),
      listMovements: jest.fn(async (_brandId: string) => ({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })),
    }
    const controller = new TokenWalletController(tokenWallets as any, platformClient as any)
    return { controller, tokenWallets, platformClient }
  }

  it('returns 403 to a member of brand B asking for the token wallet of brand A', async () => {
    // R15: red when the controller skips assertBrandAccess: brand A wallet comes back with 200.
    const { controller, tokenWallets, platformClient } = build()

    await expect(controller.get(BRAND_A, MEMBER_OF_B)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
    expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith('member-of-b', BRAND_A)
    expect(tokenWallets.getOrCreate).not.toHaveBeenCalled()
  })

  it('returns the token wallet of the brand the caller belongs to', async () => {
    // R15: red when the wallet is created in the brand's name instead of the caller's user id.
    const { controller, tokenWallets } = build()

    const res = await controller.get(BRAND_B, MEMBER_OF_B)

    expect(tokenWallets.getOrCreate).toHaveBeenCalledWith(BRAND_B, 'member-of-b')
    expect(res).toEqual({ data: { id: 'w', brandId: BRAND_B } })
  })

  it('lets a super admin read any brand token wallet', async () => {
    // R15: red when a super admin is not a privileged caller: platform says no and the call is 403.
    const { controller, platformClient } = build()

    const res = await controller.get(BRAND_A, { user: { id: 'root', isSuperAdmin: true } })

    expect(res.data).toEqual({ id: 'w', brandId: BRAND_A })
    expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
  })

  it('returns 403 to a member of brand B asking for the token wallet movements of brand A', async () => {
    // R15: red when listMovements skips assertBrandAccess: brand A movements come back with 200.
    const { controller, tokenWallets, platformClient } = build()

    await expect(controller.listMovements({ brandId: BRAND_A }, MEMBER_OF_B)).rejects.toMatchObject(
      {
        status: HttpStatus.FORBIDDEN,
      },
    )
    expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith('member-of-b', BRAND_A)
    expect(tokenWallets.listMovements).not.toHaveBeenCalled()
  })

  it('lists the token wallet movements of the brand the caller belongs to', async () => {
    // R15: red when listMovements does not forward the validated brandId and query filters.
    const { controller, tokenWallets } = build()
    const query = { brandId: BRAND_B, page: 2, limit: 10 }

    const res = await controller.listMovements(query, MEMBER_OF_B)

    expect(tokenWallets.listMovements).toHaveBeenCalledWith(BRAND_B, query)
    expect(res).toEqual({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } })
  })
})
