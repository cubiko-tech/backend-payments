import { readFileSync } from 'fs'
import { isUUID } from 'class-validator'
import { config as dotenvConfig } from 'dotenv'
import { DataSource } from 'typeorm'
import {
  BrandOwnerErrorCode,
  BrandOwnerResolution,
  ClientPlatformService,
} from '../client/client-platform.service'
import { Wallet, WalletProvider, WalletStatus } from './entities/wallet.entity'
import { isTokenCurrency, TOKEN_CURRENCY } from './token-origin'
import { isProductionEnv } from '../shared/env/is-production'

/** The slice of `ClientPlatformService` the backfill reads: which brands exist and who owns each. */
export interface BrandDirectory {
  listBrandIds(): Promise<string[]>
  resolveBrandOwner(brandId: string): Promise<BrandOwnerResolution>
}

export interface BackfillTokenWalletsOptions {
  dataSource: DataSource
  platform: BrandDirectory
  apply?: boolean
  brandIdsFromFile?: readonly string[]
  brandsFilePath?: string
}

export interface OmittedBrand {
  brandId: string
  reason: BrandOwnerErrorCode
}

export interface BackfillTokenWalletsResult {
  apply: boolean
  missingBrandIds: string[]
  omittedBrands: OmittedBrand[]
  createdBrandIds: string[]
  tokenWalletsBefore: number
  tokenWalletsAfter: number
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

async function brandsWithTokenWallet(dataSource: DataSource): Promise<string[]> {
  const wallets = await dataSource.getRepository(Wallet).find({
    select: ['brandId', 'provider', 'currency'],
  })
  return wallets
    .filter(
      (w) => w.brandId && w.provider === WalletProvider.INTERNAL && isTokenCurrency(w.currency),
    )
    .map((w) => w.brandId)
}

/**
 * Candidates are platform's brands, or only the file's when one is given, minus those that
 * already hold their internal TKN wallet. Each candidate is checked in platform before opening.
 */
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

  const fromFile = options.brandsFilePath !== undefined || options.brandIdsFromFile !== undefined
  const sourceIds = fromFile ? [...fileIds, ...extraIds] : await options.platform.listBrandIds()

  const tokenBrandsBefore = await brandsWithTokenWallet(options.dataSource)
  const withToken = new Set(tokenBrandsBefore)
  const missingBrandIds = Array.from(new Set(sourceIds))
    .filter((brandId) => !withToken.has(brandId))
    .sort()

  const omittedBrands: OmittedBrand[] = []
  const ownerByBrand = new Map<string, string>()
  for (const brandId of missingBrandIds) {
    const owner = await options.platform.resolveBrandOwner(brandId)
    if (owner.ok) ownerByBrand.set(brandId, owner.owner)
    else omittedBrands.push({ brandId, reason: owner.code })
  }

  const tokenWalletsBefore = tokenBrandsBefore.length
  if (!apply) {
    return {
      apply: false,
      missingBrandIds,
      omittedBrands,
      createdBrandIds: [],
      tokenWalletsBefore,
      tokenWalletsAfter: tokenWalletsBefore,
    }
  }

  const walletRepo = options.dataSource.getRepository(Wallet)
  const createdBrandIds: string[] = []
  for (const [brandId, userId] of ownerByBrand) {
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

  const tokenWalletsAfter = (await brandsWithTokenWallet(options.dataSource)).length
  return {
    apply,
    missingBrandIds,
    omittedBrands,
    createdBrandIds,
    tokenWalletsBefore,
    tokenWalletsAfter,
  }
}

/** TLS always verifies the certificate; production without `SSL_CA_CERT` refuses to connect. */
export function backfillSslOptions(
  env: NodeJS.ProcessEnv,
): { ca?: string; rejectUnauthorized: true } | undefined {
  if (env.SSL !== 'true') return undefined
  if (env.SSL_CA_CERT) return { ca: env.SSL_CA_CERT, rejectUnauthorized: true }
  if (isProductionEnv(env)) {
    throw new Error('SSL=true without SSL_CA_CERT in production: refusing an unverified connection')
  }
  return { rejectUnauthorized: true }
}

export async function runBackfillTokenWalletsCli(
  argv: readonly string[] = process.argv.slice(2),
  createDataSource?: () => DataSource,
  writeLine: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  platform: BrandDirectory = new ClientPlatformService(),
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
      ssl: backfillSslOptions(process.env),
    })

  const initializedHere = !dataSource.isInitialized
  if (initializedHere) {
    await dataSource.initialize()
  }
  try {
    const result = await backfillTokenWallets({ dataSource, platform, apply, brandsFilePath })
    const omittedByReason: Record<string, number> = {}
    for (const { reason } of result.omittedBrands) {
      omittedByReason[reason] = (omittedByReason[reason] ?? 0) + 1
    }
    writeLine(
      JSON.stringify({
        apply: result.apply,
        count: result.missingBrandIds.length,
        missingBrandIds: result.missingBrandIds,
        omittedByReason,
        omittedBrands: result.omittedBrands,
        createdCount: result.createdBrandIds.length,
        createdBrandIds: result.createdBrandIds,
        ...(result.apply
          ? {
              tokenWalletsBefore: result.tokenWalletsBefore,
              tokenWalletsAfter: result.tokenWalletsAfter,
            }
          : {}),
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
