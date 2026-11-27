import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common'
import { QueryFailedError } from 'typeorm'

import { logger } from '../logger/logger'
import { createGlobalValidationPipe } from '../validation/global-validation-pipe'
import { HttpErrorFilter } from './http-error.filter'
import { RequestException } from './request.exception'

// R17: a captured response is the only way to read what the filter sends without an HTTP server.
function respond(
  exception: unknown,
  request: object = {
    method: 'POST',
    path: '/v1/admin/payments/x/retry',
    originalUrl: '/v1/admin/payments/x/retry',
  },
) {
  const json = jest.fn()
  const status = jest.fn().mockReturnValue({ json })
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost
  new HttpErrorFilter().catch(exception, host)
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] }
}

describe('HttpErrorFilter', () => {
  let logError: jest.SpyInstance

  beforeEach(() => {
    // R17: the 5xx detail goes to the log; the spy keeps it out of the log files and lets cases read it.
    logError = jest.spyOn(logger, 'error').mockImplementation(() => logger)
  })

  afterEach(() => jest.restoreAllMocks())

  it('answers a RequestException 4xx with statusCode, code, message and only the public detail keys', () => {
    // R15: red when the filter spreads the exception body: `error`, `status` and `query` reach the client.
    const { status, body } = respond(
      new RequestException(
        {
          error: 'raw text',
          code: 'PAYMENT_NOT_FOUND',
          message: 'Pago no encontrado',
          paymentId: 'p-1',
          query: 'SELECT 1',
        },
        HttpStatus.NOT_FOUND,
      ),
    )

    expect(status).toBe(404)
    expect(body).toEqual({
      statusCode: 404,
      code: 'PAYMENT_NOT_FOUND',
      message: 'Pago no encontrado',
      paymentId: 'p-1',
    })
    expect(logError).not.toHaveBeenCalled()
  })

  it('never uses `error` as the message of a 4xx that carries no message', () => {
    // R15: red when the message falls back to the body's `error` instead of the fixed text of the status.
    const { body } = respond(
      new RequestException(
        { error: 'duplicate key value violates', code: 'forbidden' },
        HttpStatus.FORBIDDEN,
      ),
    )

    expect(body).toEqual({ statusCode: 403, code: 'forbidden', message: 'Forbidden' })
  })

  it('derives the code from the status when the exception carries none', () => {
    // R15: red when the derived code is dropped: a Nest NotFoundException has no `code`.
    const { body } = respond(new NotFoundException('Cannot GET /v1/nope'))

    expect(body).toEqual({ statusCode: 404, code: 'notFound', message: 'Cannot GET /v1/nope' })
  })

  it('keeps the string body of an HttpException as its message', () => {
    // R15: red without the string-body branch: the message falls back to the fixed text.
    const { body } = respond(new HttpException('Firma de Stripe inválida', HttpStatus.UNAUTHORIZED))

    expect(body).toEqual({
      statusCode: 401,
      code: 'unauthorized',
      message: 'Firma de Stripe inválida',
    })
  })

  it('keeps the INVALID_REQUEST code and the field list of the global validation pipe', async () => {
    // R15: red when the filter drops an array message or replaces the pipe's code.
    class Probe {}
    const pipe = createGlobalValidationPipe()
    const thrown = await pipe
      .transform({ extra: 1 }, { type: 'body', metatype: Probe })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(BadRequestException)
    expect(respond(thrown).body).toEqual({
      statusCode: 400,
      code: 'INVALID_REQUEST',
      message: ['property extra should not exist'],
    })
  })

  it('answers a QueryFailedError with 500 internalError and no SQL or parameters in the body', () => {
    // R15: red when the 5xx message is built from the original error: the SQL reaches the body.
    const error = new QueryFailedError(
      'INSERT INTO "wallets" ("brandId") VALUES ($1)',
      ['brand-secret-1'],
      new Error('duplicate key value violates unique constraint "IDX_wallet"'),
    )

    const { status, body } = respond(error)

    expect(status).toBe(500)
    expect(body).toEqual({
      statusCode: 500,
      code: 'internalError',
      message: 'Internal server error',
    })
    expect(JSON.stringify(body)).not.toMatch(/INSERT|brand-secret-1|duplicate key/)
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('duplicate key'), {
      stack: error.stack,
    })
  })

  it('answers an unexpected error with 500 internalError and no stack in the body', () => {
    // R15: red when the body carries the stack or the code stops being internalError.
    const { body } = respond(new TypeError("Cannot read properties of undefined (reading 'id')"))

    expect(body).toEqual({
      statusCode: 500,
      code: 'internalError',
      message: 'Internal server error',
    })
    expect(JSON.stringify(body)).not.toMatch(/reading 'id'|at /)
  })

  it('answers a middleware error with a 4xx statusCode with that status and never its own message', () => {
    // R15: red when the middleware branch answers with the error's message: the parser's limit text reaches the body.
    const { status, body } = respond(
      Object.assign(new Error('request entity too large: limit 102400'), {
        statusCode: 413,
        type: 'entity.too.large',
      }),
    )

    expect(status).toBe(413)
    expect(body).toEqual({ statusCode: 413, code: 'payloadTooLarge', message: 'Payload too large' })
    expect(logError).not.toHaveBeenCalled()
  })

  it('keeps the code of a 5xx HttpException but never its message', () => {
    // R15: red when a 5xx keeps the message it was thrown with: the provider text reaches the body.
    const { status, body } = respond(
      new RequestException(
        { code: 'WALLET_DEBIT_FAILED', message: 'relation "wallets" does not exist' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
    )

    expect(status).toBe(500)
    expect(body).toEqual({
      statusCode: 500,
      code: 'WALLET_DEBIT_FAILED',
      message: 'Internal server error',
    })
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('relation "wallets"'),
      expect.any(Object),
    )
  })

  it('logs a 5xx with the method and the path, never the query that can carry an email', () => {
    // Mutation: HttpErrorFilter.catch logs `originalUrl` again -> the email reaches the log.
    const url = '/v1/admin/credit/activation-requests?search=ana@ejemplo.co'
    const { body } = respond(new Error('forced failure'), {
      method: 'GET',
      path: '/v1/admin/credit/activation-requests',
      originalUrl: url,
      url,
    })

    expect(body).toEqual({
      statusCode: 500,
      code: 'internalError',
      message: 'Internal server error',
    })
    const line = logError.mock.calls[0][0] as string
    expect(line).toContain('GET /v1/admin/credit/activation-requests -> 500')
    expect(line).not.toMatch(/search=|ana@ejemplo\.co/)
  })
})
