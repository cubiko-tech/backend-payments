import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * Excepción personalizada para respuestas HTTP
 */
export class RequestException extends HttpException {
  public readonly code?: string

  constructor(
    error: Record<string, any>,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ ...error, status }, status)
    this.code = error.code
  }
}

/**
 * Excepción de autenticación
 */
export class UnauthorizedException extends HttpException {
  constructor(code: string, status: HttpStatus = HttpStatus.UNAUTHORIZED) {
    super(
      {
        code,
        error: 'Unauthorized',
        status,
      },
      status,
    )
  }
}
