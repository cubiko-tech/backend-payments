import { randomUUID } from 'crypto'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner, Repository } from 'typeorm'
import { Invoice } from '../src/invoice/entities/invoice.entity'
import { InvoiceItem } from '../src/invoice/entities/invoiceItem.entity'
import { InvoiceService } from '../src/invoice/invoice.service'

const BRAND_ID = 'a7990092-2222-4333-8444-555555555555'

describe('InvoiceService.create on a real primary (Postgres)', () => {
  let dataSource: DataSource
  let invoices: Repository<Invoice>
  let items: Repository<InvoiceItem>

  beforeAll(async () => {
    dotenvConfig({ path: '.env' })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Invoice, InvoiceItem],
      synchronize: false,
      ...(process.env.SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    })
    await dataSource.initialize()
    invoices = dataSource.getRepository(Invoice)
    items = dataSource.getRepository(InvoiceItem)
  })

  afterEach(async () => {
    const created = await invoices.find({ where: { brandId: BRAND_ID } })
    if (created.length > 0) {
      await items.delete(created.map((invoice) => ({ invoiceId: invoice.id })))
      await invoices.delete(created.map((invoice) => invoice.id))
    }
  })

  afterAll(async () => {
    await dataSource.destroy()
  })

  const payload = (paymentId: string) => ({
    brandId: BRAND_ID,
    paymentId,
    invoiceNumber: `LOC92-${randomUUID()}`,
    subtotal: 100000,
    taxTotal: 19000,
    total: 119000,
    currency: 'COP',
    items: [
      {
        description: 'Wallet recharge',
        quantity: 1,
        unitPrice: 100000,
        subtotal: 100000,
        taxRate: 0.19,
        taxAmount: 19000,
        total: 119000,
      },
    ],
  })

  const buildService = (
    overrides: {
      primary?: Repository<Invoice>
      replica?: Repository<Invoice>
      prepareRunner?: (runner: QueryRunner) => void
    } = {},
  ) => {
    // R17: a query runner over Postgres with one forced fault, because a rollback cannot be made to fail on demand.
    const runnerSource = {
      createQueryRunner: () => {
        const runner = dataSource.createQueryRunner()
        overrides.prepareRunner?.(runner)
        return runner
      },
    } as unknown as DataSource
    return new InvoiceService(
      overrides.primary ?? invoices,
      overrides.replica ?? invoices,
      items,
      runnerSource,
    )
  }

  // R17: the real rollback runs on release, so the bench gives back a clean connection to its pool.
  const failRollback = (runner: QueryRunner) => {
    const realRollback = runner.rollbackTransaction.bind(runner)
    const realRelease = runner.release.bind(runner)
    runner.rollbackTransaction = async () => {
      throw new Error('rollback failed')
    }
    runner.release = async () => {
      await realRollback()
      return realRelease()
    }
  }

  // Hides the winner from the pre-check only, as in a race where the other commit lands right after it.
  const missWinnerOnPreCheck = (runner: QueryRunner) => {
    const realFindOne = runner.manager.findOne.bind(runner.manager)
    let calls = 0
    runner.manager.findOne = (async (...args: Parameters<typeof realFindOne>) => {
      calls += 1
      return calls === 1 ? null : realFindOne(...args)
    }) as typeof runner.manager.findOne
  }

  // R17: a repository whose reads fail like an unreachable database, which Postgres here cannot be made to do.
  const unreachable = () =>
    ({
      findOne: jest.fn().mockRejectedValue(new Error('primary read failed')),
    }) as unknown as Repository<Invoice>

  const seedWinner = async (paymentId: string) => {
    const seeded = await buildService().create(payload(paymentId))
    return seeded.data as Invoice
  }

  describe('reload after the commit', () => {
    it.each([
      ['has no row yet', null],
      ['has a copy without items', { id: 'stale', items: [] }],
    ])('returns the items when the replica %s', async (_state, replicaRow) => {
      // R17: a double, because a real replica cannot be made to lag on demand here.
      const replica = {
        findOne: jest.fn().mockResolvedValue(replicaRow),
      } as unknown as Repository<Invoice>
      const service = buildService({ replica })

      // R15: red if the reload at invoice.service.ts goes back to invoiceReadRepository.
      const result = await service.create(payload(randomUUID()))

      expect(result.error).toBeUndefined()
      expect(result.data.id).not.toBe('stale')
      expect(result.data.items.map((item) => item.description)).toEqual(['Wallet recharge'])
    })

    it('returns the read error, and a retry finds the invoice, when the reload fails', async () => {
      const paymentId = randomUUID()
      const service = buildService({ primary: unreachable() })

      // R15: red if the catch rollback is awaited unprotected: there is no transaction left to revert.
      const result = await service.create(payload(paymentId))

      expect(result).toEqual({ error: 'primary read failed' })
      const retried = await buildService().create(payload(paymentId))
      expect(retried.data.items).toHaveLength(1)
      await expect(invoices.count({ where: { paymentId } })).resolves.toBe(1)
    })
  })

  describe('a rollback that fails', () => {
    it('keeps the original error when saving failed', async () => {
      const paymentId = randomUUID()
      const service = buildService({
        prepareRunner: (runner) => {
          failRollback(runner)
          // R17: a double, because this save has no real constraint to break without a winner.
          runner.manager.save = jest.fn().mockRejectedValue(new Error('save failed'))
        },
      })

      // R15: red if the catch rollback is awaited unprotected: create rejects with the rollback error.
      const result = await service.create(payload(paymentId))

      expect(result).toEqual({ error: 'save failed' })
      await expect(invoices.count({ where: { paymentId } })).resolves.toBe(0)
    })

    it('still recovers the winner of a duplicate race', async () => {
      const paymentId = randomUUID()
      const winner = await seedWinner(paymentId)
      const service = buildService({
        prepareRunner: (runner) => {
          failRollback(runner)
          missWinnerOnPreCheck(runner)
        },
      })

      // R15: red if a failed read escapes findExistingByPaymentId: this transaction is really aborted.
      const result = await service.create(payload(paymentId))

      expect(result.data.id).toBe(winner.id)
      expect(result.data.items).toHaveLength(1)
      await expect(invoices.count({ where: { paymentId } })).resolves.toBe(1)
    })

    it('returns the original duplicate error when no read answers', async () => {
      const paymentId = randomUUID()
      await seedWinner(paymentId)
      const service = buildService({
        primary: unreachable(),
        replica: unreachable(),
        prepareRunner: (runner) => {
          failRollback(runner)
          missWinnerOnPreCheck(runner)
        },
      })

      // R15: red if a failed read escapes findExistingByPaymentId: its error replaces the duplicate one.
      const result = await service.create(payload(paymentId))

      expect(result.data).toBeUndefined()
      expect(result.error).toMatch(/duplicate key/)
    })

    it('still returns the invoice the pre-check found', async () => {
      const paymentId = randomUUID()
      const winner = await seedWinner(paymentId)
      const service = buildService({ prepareRunner: failRollback })

      // R15: red if the pre-check rollback is awaited unprotected: its error replaces the found invoice.
      const result = await service.create(payload(paymentId))

      expect(result.data.id).toBe(winner.id)
      expect(result.error).toBeUndefined()
    })
  })
})
