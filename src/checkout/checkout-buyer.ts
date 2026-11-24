import { HttpStatus } from '@nestjs/common'

import { ClientAuthService, USER_LOOKUP_UNAVAILABLE } from '../client/client-auth.service'
import { BRAND_LOOKUP_UNAVAILABLE, ClientPlatformService } from '../client/client-platform.service'
import { buildConfioBuyer, assertConfioBuyer } from '../provider/confio/confio-buyer'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { RequestException } from '../shared/exception/request.exception'

type CheckoutBuyer = { firstName?: string; lastName?: string; email?: string; phoneNumber?: string }

/** The buyer's contact could not be looked up. Carries only the code, never contact data. */
export class BuyerLookupFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }

  toException(): RequestException {
    const transient =
      this.code === USER_LOOKUP_UNAVAILABLE || this.code === BRAND_LOOKUP_UNAVAILABLE
    return new RequestException(
      { code: this.code, message: 'No se pudo consultar el contacto de quien compra' },
      transient ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
}

/**
 * The buyer a one-shot Confio link is created with. A usable request buyer goes as is; otherwise
 * the contact comes from auth for the request's user, or for the brand owner when there is no user,
 * keeping the name and email the request did bring. Nothing is made up: an unusable auth contact
 * throws the `invalid_buyer` input error, and a lookup failure throws `BuyerLookupFailure`.
 */
export async function resolveCheckoutBuyer(
  req: { provider: string; brandId: string; userId?: string; buyer?: CheckoutBuyer },
  clientAuth: Pick<ClientAuthService, 'resolveBuyerContact'> | undefined,
  clientPlatform: Pick<ClientPlatformService, 'resolveBrandOwner'>,
): Promise<CheckoutBuyer | undefined> {
  if (req.provider !== 'confio' || isUsable(req.buyer)) return req.buyer
  if (!clientAuth) throw new BuyerLookupFailure(USER_LOOKUP_UNAVAILABLE)

  let userId = req.userId
  if (!userId) {
    const owner = await clientPlatform.resolveBrandOwner(req.brandId)
    if (!owner.ok) throw new BuyerLookupFailure(owner.code)
    userId = owner.owner
  }
  const contact = await clientAuth.resolveBuyerContact(userId)
  if (!contact.ok) throw new BuyerLookupFailure(contact.code)

  const name = [req.buyer?.firstName, req.buyer?.lastName].filter(Boolean).join(' ')
  return buildConfioBuyer({
    ...contact.contact,
    email: req.buyer?.email || contact.contact.email,
    name: name || contact.contact.name,
  })
}

/** Usable means the provider would accept it as sent, judged with the provider's own rules. */
function isUsable(buyer?: CheckoutBuyer): boolean {
  if (!buyer) return false
  try {
    assertConfioBuyer({
      firstName: buyer.firstName,
      lastName: buyer.lastName,
      email: buyer.email,
      phoneNumber: ConfioProvider.normalizeColombianPhone(buyer.phoneNumber),
    })
    return true
  } catch (error) {
    if (error instanceof ConfioSubscriptionInputError) return false
    throw error
  }
}
