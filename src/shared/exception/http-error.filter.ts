import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'

import { logger } from '../logger/logger'

/** Extra keys a 4xx body may carry besides `statusCode`, `code` and `message`; anything else is dropped. */
const PUBLIC_DETAIL_KEYS = [
  'field',
  'paymentId',
  'permission',
  'from',
  'to',
  'amount',
  'totalTokens',
]

const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'badRequest',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'notFound',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'methodNotAllowed',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'payloadTooLarge',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'unprocessableEntity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'tooManyRequests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'internalError',
  [HttpStatus.BAD_GATEWAY]: 'badGateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'serviceUnavailable',
}

const MESSAGE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method not allowed',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload too large',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
  [HttpStatus.BAD_GATEWAY]: 'Upstream provider rejected the request',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable, try again later',
}

const INTERNAL_ERROR_MESSAGE = 'Internal server error'

interface HttpErrorBody {
  statusCode: number
  code: string
  message: string | string[]
  [detail: string]: unknown
}

/**
 * Answers every error as `{ statusCode, code, message }` (R39). A 4xx keeps the `code` and `message` the
 * code wrote on purpose, plus the keys in `PUBLIC_DETAIL_KEYS`; it never echoes `error`, `driverError`,
 * `query`, `parameters` or a stack. A 5xx keeps its `code` but its message is always generic: the
 * original goes to the log, with the path and never the query (it can carry an email). A
 * non-`HttpException` with a 4xx `statusCode` (Express middleware) answers that status with the code
 * and message of the status; anything else is `500 internalError`.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const request = ctx.getRequest()
    const body = toErrorBody(exception)

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const error = exception instanceof Error ? exception : undefined
      logger.error(
        `${request?.method} ${request?.path} -> ${body.statusCode} ${body.code}: ` +
          `${error?.message ?? String(exception)}`,
        { stack: error?.stack },
      )
    }

    ctx.getResponse().status(body.statusCode).json(body)
  }
}

function toErrorBody(exception: unknown): HttpErrorBody {
  if (!(exception instanceof HttpException)) {
    const clientStatus = (exception as { statusCode?: unknown })?.statusCode
    if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
      return {
        statusCode: clientStatus,
        code: CODE_BY_STATUS[clientStatus] ?? 'httpError',
        message: MESSAGE_BY_STATUS[clientStatus] ?? 'Bad request',
      }
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internalError',
      message: INTERNAL_ERROR_MESSAGE,
    }
  }

  const statusCode = exception.getStatus()
  const response = exception.getResponse()
  const fields =
    typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {}
  const code =
    typeof fields.code === 'string' && fields.code
      ? fields.code
      : (CODE_BY_STATUS[statusCode] ?? 'httpError')
  const fallback = MESSAGE_BY_STATUS[statusCode] ?? INTERNAL_ERROR_MESSAGE

  if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return { statusCode, code, message: fallback }
  }

  const body: HttpErrorBody = {
    statusCode,
    code,
    message: clientMessage(response, fields) ?? fallback,
  }
  for (const key of PUBLIC_DETAIL_KEYS) {
    if (fields[key] !== undefined) body[key] = fields[key]
  }
  return body
}

/** A message written on purpose for the caller: the string body, or the body's `message`; never `error`. */
function clientMessage(
  response: string | object,
  fields: Record<string, unknown>,
): string | string[] | undefined {
  if (typeof response === 'string') return response
  const { message } = fields
  if (typeof message === 'string' && message) return message
  if (Array.isArray(message) && message.every((m) => typeof m === 'string')) return message
  return undefined
}
