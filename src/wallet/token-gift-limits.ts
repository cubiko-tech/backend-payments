const DEFAULT_MAX_TOKENS_PER_BRAND = 10000
const DEFAULT_BATCH_SIZE = 500

export interface TokenGiftLimits {
  maxTokensPerBrand: number
  batchSize: number
}

/** Non-positive or malformed env values fall back to safe defaults (10,000 cap, 500 chunk size). */
export function tokenGiftLimits(): TokenGiftLimits {
  return {
    maxTokensPerBrand: positiveInteger(
      process.env.TOKEN_GIFT_MAX_TOKENS_PER_BRAND,
      DEFAULT_MAX_TOKENS_PER_BRAND,
    ),
    batchSize: positiveInteger(process.env.TOKEN_GIFT_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  }
}

/** Kept outside the `admin:` namespace so a single-brand gift key cannot collide with a batch item. */
export const giftBatchBrandKey = (batchId: string, brandId: string): string =>
  `gift-batch:${batchId}:${brandId}`

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
