import { readFileSync } from 'fs'
import { isUUID } from 'class-validator'
import { config as dotenvConfig } from 'dotenv'
import { DataSource } from 'typeorm'
import { Wallet, WalletProvider, WalletStatus } from './entities/wallet.entity'
import { isTokenCurrency, TOKEN_CURRENCY } from './token-origin'

export interface BackfillTokenWalletsOptions {
  dataSource: DataSource
  apply?: boolean
  brandIdsFromFile?: readonly string[]
  brandsFilePath?: string
}

export interface BackfillTokenWalletsResult {
  apply: boolean
  missingBrandIds: string[]
  createdBrandIds: string[]
}

export interface BackfillCliArgs {
  apply: boolean
  brandsFilePath?: string
}

export function parseBackfillBrandIds(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  let tokens: unknown[]
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      throw new Error('Expected a JSON array of brand UUIDs')
    }
    tokens = parsed.map((entry) => {
      if (typeof entry === 'string') return entry.trim()
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        const candidate = record.brandId ?? record.id
        if (typeof candidate === 'string') return candidate.trim()
      }
      return entry
    })
  } else {
    tokens = trimmed
      .split(/[\r\n,;\t ]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  const unique = new Set<string>()
  for (const token of tokens) {
    if (typeof token !== 'string' || !isUUID(token)) {
      throw new Error(`Invalid brand UUID in file: ${String(token)}`)
    }
    unique.add(token)
  }
  return Array.from(unique)
}

export function parseBackfillArgs(argv: readonly string[]): BackfillCliArgs {
  let apply = false
  let brandsFilePath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') {
      apply = true
    } else if (arg === '--brands-file' || arg === '--file') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing path after ${arg}`)
      }
      brandsFilePath = next
      i++
    } else if (arg.startsWith('--brands-file=')) {
      brandsFilePath = arg.slice('--brands-file='.length)
    } else if (arg.startsWith('--file=')) {
      brandsFilePath = arg.slice('--file='.length)
    } else if (!arg.startsWith('-') && !brandsFilePath) {
      brandsFilePath = arg
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { apply, brandsFilePath }
}

export async function backfillTokenWallets(
  options: BackfillTokenWalletsOptions,
): Promise<BackfillTokenWalletsResult> {
  const apply = options.apply === true
  const fileIds = options.brandsFilePath
    ? parseBackfillBrandIds(readFileSync(options.brandsFilePath, 'utf8'))
    : []
  const extraIds = options.brandIdsFromFile ?? []
  for (const id of extraIds) {
    if (typeof id !== 'string' || !isUUID(id)) {
      throw new Error(`Invalid brand UUID: ${String(id)}`)
    }
  }

  const walletRepo = options.dataSource.getRepository(Wallet)
  const existingWallets = await walletRepo.find({
    select: ['brandId', 'userId', 'provider', 'currency'],
  })

  const candidateBrands = new Set<string>([...fileIds, ...extraIds])
  const brandsWithTokenWallet = new Set<string>()
  const userByBrand = new Map<string, string>()

  for (const wallet of existingWallets) {
    if (!wallet.brandId) continue
    candidateBrands.add(wallet.brandId)
    if (wallet.userId && !userByBrand.has(wallet.brandId)) {
      userByBrand.set(wallet.brandId, wallet.userId)
    }
    if (wallet.provider === WalletProvider.INTERNAL && isTokenCurrency(wallet.currency)) {
      brandsWithTokenWallet.add(wallet.brandId)
    }
  }

  const missingBrandIds = Array.from(candidateBrands)
    .filter((brandId) => !brandsWithTokenWallet.has(brandId))
    .sort()

  if (!apply) {
    return { apply: false, missingBrandIds, createdBrandIds: [] }
  }

  const createdBrandIds: string[] = []
  for (const brandId of missingBrandIds) {
    const userId = userByBrand.get(brandId) || brandId
    const insertResult = await walletRepo
      .createQueryBuilder()
      .insert()
      .into(Wallet)
      .values({
        brandId,
        userId,
        provider: WalletProvider.INTERNAL,
        currency: TOKEN_CURRENCY,
        balance: 0,
        giftTokens: 0,
        purchasedTokens: 0,
        dropiTokens: 0,
        status: WalletStatus.ACTIVE,
      })
      .orIgnore()
      .execute()
    const inserted = Array.isArray(insertResult.raw)
      ? insertResult.raw.length > 0
      : insertResult.identifiers.some((item) => Boolean(item?.id))
    if (inserted) {
      createdBrandIds.push(brandId)
    }
  }

  return { apply, missingBrandIds, createdBrandIds }
}

export async function runBackfillTokenWalletsCli(
  argv: readonly string[] = process.argv.slice(2),
  createDataSource?: () => DataSource,
  writeLine: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<BackfillTokenWalletsResult> {
  dotenvConfig({ path: '.env' })
  const { apply, brandsFilePath } = parseBackfillArgs(argv)
  const dataSource =
    createDataSource?.() ??
    new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT || 5432),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Wallet],
      synchronize: false,
      ...(process.env.SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    })

  const initializedHere = !dataSource.isInitialized
  if (initializedHere) {
    await dataSource.initialize()
  }
  try {
    const result = await backfillTokenWallets({ dataSource, apply, brandsFilePath })
    writeLine(
      JSON.stringify({
        apply: result.apply,
        count: result.missingBrandIds.length,
        missingBrandIds: result.missingBrandIds,
        createdBrandIds: result.createdBrandIds,
      }),
    )
    return result
  } finally {
    if (initializedHere && dataSource.isInitialized) {
      await dataSource.destroy()
    }
  }
}

if (require.main === module) {
  runBackfillTokenWalletsCli().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
