import { HttpStatus } from '@nestjs/common'
import { WalletService } from './wallet.service'
import { WalletStatus } from './entities/wallet.entity'

const BRAND = 'a1320000-0000-4000-8000-00000000000a'

describe('WalletService keeps token wallets out of money paths (LOC-132)', () => {
  // R17: these refusals happen before any write; the doubles only record that nothing was written.
  const build = (wallets: Record<string, any> = {}) => {
    const walletRepo = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((d) => d),
      save: jest.fn((d) => Promise.resolve({ id: 'new', ...d })),
    }
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(async (_entity, opts) => wallets[opts.where.id] ?? null),
        save: jest.fn(),
        create: jest.fn((_e, d) => d),
      },
    }
    const dataSource = { createQueryRunner: () => queryRunner }
    const service = new WalletService(
      walletRepo as any,
      walletRepo as any,
      null as any,
      null as any,
      dataSource as any,
    )
    return { service, walletRepo, queryRunner }
  }

  it.each(['TKN', 'tkn'])(
    'refuses to create a wallet in %s through POST /wallet',
    async (currency) => {
      // R15: red when create accepts TKN: a second token wallet is saved for the brand.
      const { service, walletRepo } = build()

      await expect(
        service.create({ brandId: BRAND, provider: 'stripe', currency, userId: 'u' }),
      ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY })
      expect(walletRepo.save).not.toHaveBeenCalled()
    },
  )

  it('refuses to transfer between two token wallets and moves nothing', async () => {
    // R15: red when transfer accepts TKN: both wallets are saved with moved balances.
    const tokenWallet = (id: string) => ({
      id,
      brandId: BRAND,
      currency: 'TKN',
      status: WalletStatus.ACTIVE,
      balance: 50,
    })
    const { service, queryRunner } = build({ 'w-1': tokenWallet('w-1'), 'w-2': tokenWallet('w-2') })

    await expect(
      service.transfer({ fromWalletId: 'w-1', toWalletId: 'w-2', amount: 10 }),
    ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY })
    expect(queryRunner.manager.save).not.toHaveBeenCalled()
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled()
  })
})
