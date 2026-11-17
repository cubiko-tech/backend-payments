import { HttpStatus } from '@nestjs/common'
import { RequestException } from '../shared/exception/request.exception'
import { WalletService } from './wallet.service'

describe('WalletService.credit — positive finite amount guard (LOC-133)', () => {
  // R17: the guard must refuse before any query; a runner that records calls is all it needs.
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: { findOne: jest.fn(), save: jest.fn() },
  }
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) }
  const service = new WalletService(
    null as any,
    null as any,
    null as any,
    null as any,
    dataSource as any,
  )

  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -5],
    ['numeric string', '20' as unknown as number],
  ])(
    'rejects a %s amount with 400 INVALID_AMOUNT before opening a transaction',
    async (_l, amount) => {
      // R15: red when credit goes back to `Number(amount)` without the guard: it opens a runner.
      const failure = await service.credit('w-1', amount, { brandId: 'brand-a' }).catch((e) => e)

      expect(failure).toBeInstanceOf(RequestException)
      expect((failure as RequestException).getStatus()).toBe(HttpStatus.BAD_REQUEST)
      expect((failure as RequestException).code).toBe('INVALID_AMOUNT')
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled()
      expect(queryRunner.manager.save).not.toHaveBeenCalled()
    },
  )
})
