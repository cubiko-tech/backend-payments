import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common'

import { INVALID_REQUEST } from './global-validation-pipe'

const MAX_INT_COLUMN = 2147483647

/**
 * Parses a route param bound for a Postgres `int` column: only digits, from 1 to 2147483647. Anything
 * else (`1e-7`, `abc`, `null`, a value past the column) is the same 400 `INVALID_REQUEST` the global
 * pipe gives, never a `NaN` or an out-of-range number that reaches the query as a 500.
 */
export class ParseColumnIntPipe implements PipeTransform<unknown, number> {
  transform(value: unknown, metadata: ArgumentMetadata): number {
    // The global pipe may have turned the param into a number already; the text is what is checked.
    const text = String(value ?? '')
    const parsed = /^[0-9]{1,10}$/.test(text) ? Number(text) : NaN
    if (parsed >= 1 && parsed <= MAX_INT_COLUMN) return parsed

    const name = metadata.data ?? 'value'
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: [`${name} must be an integer between 1 and ${MAX_INT_COLUMN}`],
      code: INVALID_REQUEST,
    })
  }
}
