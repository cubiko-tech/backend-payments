import {
  BRAND_NOT_FOUND,
  BrandOwnerResolution,
  ClientPlatformService,
} from '../../src/client/client-platform.service'

/** The owner the double reports for every brand it knows. */
export const BRAND_OWNER_ID = 'b0000000-0000-4000-8000-0000000000ff'

/**
 * `resolveBrandOwner` as platform answers it: `BRAND_OWNER_ID` for every brand except the ids in
 * `unknown`, which are `BRAND_NOT_FOUND`.
 */
export const brandOwnerLookup =
  (unknown: string[] = []) =>
  async (brandId: string): Promise<BrandOwnerResolution> =>
    unknown.includes(brandId)
      ? { ok: false, code: BRAND_NOT_FOUND }
      : { ok: true, owner: BRAND_OWNER_ID }

/**
 * Provides `ClientPlatformService` to a suite that gifts tokens and does not exercise platform.
 * R17: platform is another service; these suites only need it to know the gifted brand.
 */
export const knownBrandOwners = (unknown: string[] = []) => ({
  provide: ClientPlatformService,
  useValue: { resolveBrandOwner: brandOwnerLookup(unknown) },
})
