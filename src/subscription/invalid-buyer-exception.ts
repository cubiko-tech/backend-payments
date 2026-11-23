import { HttpStatus } from '@nestjs/common'

import { RequestException } from '../shared/exception/request.exception'

/**
 * The 422 for a buyer ConfioPagos would reject, shared by subscriptions and one-shot checkouts.
 * Only the `field` travels: the input error's detail holds the buyer's contact.
 */
export function invalidBuyerException(field: string): RequestException {
  return new RequestException(
    {
      code: 'INVALID_BUYER',
      message: 'Los datos del comprador no cumplen lo que exige ConfioPagos',
      field,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
}
