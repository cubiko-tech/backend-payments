import { ClientAuthService } from '../client/client-auth.service'
import { buildConfioBuyer } from '../provider/confio/confio-buyer'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
import { ConfioBuyer } from '../provider/confio/confio.types'

export type RenewalBuyer =
  | { ok: true; buyer: ConfioBuyer; reason?: never }
  | { ok: false; reason: string; buyer?: never }

/**
 * The payer's contact from auth, built as the signup builds it. The reason is a code and a field,
 * never the contact itself: it is logged and stored on the cycle.
 */
export async function resolveRenewalBuyer(
  userId: string,
  clientAuth: Pick<ClientAuthService, 'resolveBuyerContact'>,
): Promise<RenewalBuyer> {
  const contact = await clientAuth.resolveBuyerContact(userId)
  if (!contact.ok) return { ok: false, reason: contact.code }
  try {
    return { ok: true, buyer: buildConfioBuyer(contact.contact) }
  } catch (error) {
    if (error instanceof ConfioSubscriptionInputError) {
      return { ok: false, reason: `${error.code} ${error.field}` }
    }
    throw error
  }
}
