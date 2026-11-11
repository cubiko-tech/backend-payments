import { giftBatchBrandKey, tokenGiftLimits } from './token-gift-limits'

describe('tokenGiftLimits and giftBatchBrandKey (LOC-253)', () => {
  const OLD_ENV = process.env

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('reads TOKEN_GIFT_MAX_TOKENS_PER_BRAND and TOKEN_GIFT_BATCH_SIZE from the environment', () => {
    // R15: red if either setting stops reading its env var and keeps the default.
    process.env = {
      ...OLD_ENV,
      TOKEN_GIFT_MAX_TOKENS_PER_BRAND: '2500',
      TOKEN_GIFT_BATCH_SIZE: '125',
    }

    expect(tokenGiftLimits()).toEqual({ maxTokensPerBrand: 2500, batchSize: 125 })
  })

  it.each(['', '0', '-5', '1e-7', '2.5', 'abc', '99999999999999999999'])(
    'falls back to 10000 and 500 when the env value is %p',
    (raw) => {
      // R15: red if a malformed value parses to NaN or 0 instead of the safe default.
      process.env = {
        ...OLD_ENV,
        TOKEN_GIFT_MAX_TOKENS_PER_BRAND: raw,
        TOKEN_GIFT_BATCH_SIZE: raw,
      }

      expect(tokenGiftLimits()).toEqual({ maxTokensPerBrand: 10000, batchSize: 500 })
    },
  )

  it('builds the per-brand batch movement key outside the admin: namespace with batchId and brandId', () => {
    // R15: red if the key drops brandId or moves back under admin:.
    const key = giftBatchBrandKey('batch-123', 'brand-456')

    expect(key).toBe('gift-batch:batch-123:brand-456')
    expect(key.startsWith('admin:')).toBe(false)
  })
})
