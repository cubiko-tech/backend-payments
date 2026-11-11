import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DataSource } from 'typeorm'
import {
  backfillTokenWallets,
  parseBackfillArgs,
  parseBackfillBrandIds,
  runBackfillTokenWalletsCli,
} from './backfill-token-wallets'
import { WalletProvider, WalletStatus } from './entities/wallet.entity'

const BRAND_1 = 'b2510000-0000-4000-8000-000000000001'
const BRAND_2 = 'b2510000-0000-4000-8000-000000000002'
const BRAND_3 = 'b2510000-0000-4000-8000-000000000003'

describe('backfill-token-wallets command helpers and dry-run/apply logic (LOC-251)', () => {
  describe('parseBackfillBrandIds', () => {
    it('parses newline-separated and JSON brand UUID lists and deduplicates them', () => {
      // R15: red when parseBackfillBrandIds stops splitting or deduplicating raw/JSON brand UUID lists.
      expect(parseBackfillBrandIds('')).toEqual([])
      expect(parseBackfillBrandIds(`${BRAND_1}\n${BRAND_2}, ${BRAND_1}`)).toEqual([
        BRAND_1,
        BRAND_2,
      ])
      expect(
        parseBackfillBrandIds(
          JSON.stringify([BRAND_1, { id: BRAND_2 }, { brandId: BRAND_3 }, BRAND_1]),
        ),
      ).toEqual([BRAND_1, BRAND_2, BRAND_3])
    })

    it('rejects non-UUID entries or non-array JSON payloads', () => {
      // R15: red when parseBackfillBrandIds skips UUID validation or accepts non-array JSON payloads.
      expect(() => parseBackfillBrandIds('not-a-uuid')).toThrow(/Invalid brand UUID/)
      expect(() => parseBackfillBrandIds('[123]')).toThrow(/Invalid brand UUID/)
      expect(() => parseBackfillBrandIds('{"id": 1}')).toThrow()
    })
  })

  describe('parseBackfillArgs', () => {
    it('parses --apply and --brands-file in flag, equals, and positional forms', () => {
      // R15: red when parseBackfillArgs ignores --apply or fails to extract the brands file path.
      expect(parseBackfillArgs([])).toEqual({ apply: false, brandsFilePath: undefined })
      expect(parseBackfillArgs(['--apply', '--brands-file', '/tmp/brands.txt'])).toEqual({
        apply: true,
        brandsFilePath: '/tmp/brands.txt',
      })
      expect(parseBackfillArgs(['--brands-file=/tmp/a.json'])).toEqual({
        apply: false,
        brandsFilePath: '/tmp/a.json',
      })
      expect(parseBackfillArgs(['--file=/tmp/b.json', '--apply'])).toEqual({
        apply: true,
        brandsFilePath: '/tmp/b.json',
      })
      expect(parseBackfillArgs(['/tmp/c.txt'])).toEqual({
        apply: false,
        brandsFilePath: '/tmp/c.txt',
      })
    })

    it('rejects missing file paths and unknown flags', () => {
      // R15: red when parseBackfillArgs silently accepts missing paths or unknown CLI flags.
      expect(() => parseBackfillArgs(['--brands-file'])).toThrow(/Missing path/)
      expect(() => parseBackfillArgs(['--file', '--apply'])).toThrow(/Missing path/)
      expect(() => parseBackfillArgs(['--unknown'])).toThrow(/Unknown argument/)
    })
  })

  describe('backfillTokenWallets and runBackfillTokenWalletsCli', () => {
    // R17: Isolates argument/file handling and dry-run guard; test/wallet-on-brand-birth.e2e-spec.ts runs against PostgreSQL.
    const buildDataSourceDouble = (rows: Array<Record<string, unknown>>) => {
      const execute = jest
        .fn()
        .mockResolvedValue({ raw: [{ id: 'w-new' }], identifiers: [{ id: 'w-new' }] })
      const qb = {
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute,
      }
      const repo = {
        find: jest.fn().mockResolvedValue(rows),
        createQueryBuilder: jest.fn(() => qb),
      }
      const ds = {
        isInitialized: false,
        initialize: jest.fn(async () => {
          ds.isInitialized = true
        }),
        destroy: jest.fn(async () => {
          ds.isInitialized = false
        }),
        getRepository: jest.fn(() => repo),
      }
      return { ds: ds as unknown as DataSource, repo, qb, execute }
    }

    it('lists missing brands without inserting when apply is false and inserts when apply is true', async () => {
      // R15: red when backfillTokenWallets inserts during dry-run or omits brands without TKN.
      const { ds, qb, execute } = buildDataSourceDouble([
        { brandId: BRAND_1, userId: 'user-1', provider: WalletProvider.INTERNAL, currency: 'COP' },
        { brandId: BRAND_2, userId: 'user-2', provider: WalletProvider.INTERNAL, currency: 'TKN' },
      ])

      const dryRun = await backfillTokenWallets({
        dataSource: ds,
        apply: false,
        brandIdsFromFile: [BRAND_3],
      })
      expect(dryRun).toEqual({
        apply: false,
        missingBrandIds: [BRAND_1, BRAND_3],
        createdBrandIds: [],
      })
      expect(execute).not.toHaveBeenCalled()

      const applied = await backfillTokenWallets({
        dataSource: ds,
        apply: true,
        brandIdsFromFile: [BRAND_3],
      })
      expect(applied).toEqual({
        apply: true,
        missingBrandIds: [BRAND_1, BRAND_3],
        createdBrandIds: [BRAND_1, BRAND_3],
      })
      expect(qb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: BRAND_1,
          userId: 'user-1',
          provider: WalletProvider.INTERNAL,
          currency: 'TKN',
          balance: 0,
          status: WalletStatus.ACTIVE,
        }),
      )
    })

    it('rejects invalid brandIdsFromFile and destroys the DataSource after CLI execution', async () => {
      // R15: red when backfillTokenWallets skips brandIdsFromFile UUID validation or leaks the DataSource.
      const { ds } = buildDataSourceDouble([])
      await expect(
        backfillTokenWallets({ dataSource: ds, brandIdsFromFile: ['invalid'] }),
      ).rejects.toThrow(/Invalid brand UUID/)

      const dir = mkdtempSync(join(tmpdir(), 'loc251-unit-'))
      try {
        const file = join(dir, 'brands.txt')
        writeFileSync(file, `${BRAND_1}\n`, 'utf8')
        const lines: string[] = []
        const res = await runBackfillTokenWalletsCli(
          ['--brands-file', file],
          () => ds,
          (line) => lines.push(line),
        )
        expect(res.missingBrandIds).toEqual([BRAND_1])
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0])).toEqual({
          apply: false,
          count: 1,
          missingBrandIds: [BRAND_1],
          createdBrandIds: [],
        })
        expect(ds.isInitialized).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
