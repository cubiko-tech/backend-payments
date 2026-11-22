import { BrandOwnerErrorCode, ClientPlatformService } from '../client/client-platform.service'
import { TokenWalletService } from './token-wallet.service'

export type OpenBrandTokenWallet =
  | { ok: true; walletId: string; code?: never }
  | { ok: false; code: BrandOwnerErrorCode; walletId?: never }

/**
 * The brand TKN wallet, opened in the brand owner's name when it does not exist yet. Platform is
 * asked only when the wallet is missing; an id platform does not know never gets a wallet.
 */
export async function openBrandTokenWallet(
  tokenWallets: Pick<TokenWalletService, 'findTokenWalletId' | 'getOrCreate'>,
  platform: Pick<ClientPlatformService, 'resolveBrandOwner'>,
  brandId: string,
): Promise<OpenBrandTokenWallet> {
  const existing = await tokenWallets.findTokenWalletId(brandId)
  if (existing) return { ok: true, walletId: existing }
  const owner = await platform.resolveBrandOwner(brandId)
  if (!owner.ok) return { ok: false, code: owner.code }
  const wallet = await tokenWallets.getOrCreate(brandId, owner.owner)
  return { ok: true, walletId: wallet.id }
}
