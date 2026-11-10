import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common'

/** Code every request-shape 400 carries, so callers can tell it from a domain rejection. */
export const INVALID_REQUEST = 'INVALID_REQUEST'

/**
 * The pipe `main.ts` installs for every route. Keeps Nest's 400 body (`statusCode`, `error`,
 * `message[]`) and adds `code: INVALID_REQUEST`.
 *
 * `transform` hands handlers the converted value: `@Query('x') x?: number` arrives as a number,
 * and as `NaN` when absent (Nest coerces with `+value`), so a default must use `||`, never `??`.
 */
export class GlobalValidationPipe extends ValidationPipe {
  constructor() {
    super({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  }

  createExceptionFactory() {
    return (errors: ValidationError[] = []) =>
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: this.flattenValidationErrors(errors),
        code: INVALID_REQUEST,
      })
  }
}

export function createGlobalValidationPipe(): ValidationPipe {
  return new GlobalValidationPipe()
}
