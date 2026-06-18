import { Injectable, NestMiddleware } from '@nestjs/common'
import { UnauthorizedException } from '../exception/request.exception'
import { JwtService } from '@nestjs/jwt'
import { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'

/**
 * Authentication Middleware para backend-payments
 *
 * Flujo de autenticación (inspirado en alerts-service):
 * 1. Extraer token (cookie o Bearer)
 * 2. ¿Es ACCESS_SERVER? → Admin (constant-time compare)
 * 3. Verificar JWT local con JWT_SECRET (HMAC-SHA256)
 * 4. Si JWT falla → fallback a POST /auth/verify/token en backend-auth
 * 5. Verificar status === 'active'
 * 6. Inyectar user en req.session['user']
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly COOKIE_SESSION = process.env.COOKIE_SESSION
  private readonly ACCESS_SERVER = process.env.ACCESS_SERVER
  private readonly SERVICE_AUTH = process.env.SERVICE_AUTH || process.env.SERVER_AUTH
  private readonly JWT_SECRET = process.env.JWT_SECRET

  constructor(private readonly jwtService: JwtService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const cookie = req.cookies?.[this.COOKIE_SESSION]
    const accessToken = this.extractBearerToken(req)

    if (!cookie && !accessToken) {
      req['user'] = null
      throw new UnauthorizedException('unauthorized')
    }

    const token = cookie || accessToken

    // 1. ¿Es ACCESS_SERVER? → Admin (constant-time compare)
    if (this.isServerToken(token)) {
      req['user'] = {
        id: 'server',
        email: 'admin@cubiko.co',
        name: 'Server Admin',
        role: 'superadmin',
        isSuperAdmin: true,
        isVerificated: true,
        status: 'active',
      }
      return next()
    }

    // 2. Intentar verificar JWT local
    let user = await this.verifyJwtLocal(token)

    // 3. Si JWT local falla → fallback a backend-auth
    if (!user) {
      user = await this.verifyViaAuthService(token)
    }

    if (!user) {
      req['user'] = null
      throw new UnauthorizedException('unauthorized')
    }

    // 4. Verificar que el usuario esté activo
    if (user.status && user.status !== 'active') {
      req['user'] = null
      throw new UnauthorizedException('userInactive')
    }

    // 5. Inyectar user en request
    req['user'] = user
    return next()
  }

  /**
   * Extraer Bearer token del header Authorization
   */
  private extractBearerToken(req: Request): string {
    const { authorization = '' } = req.headers
    if (!authorization) return ''

    const parts = authorization.split(' ')
    if (parts.length > 1 && parts[0].toLowerCase() === 'bearer') {
      return parts[1]
    }
    return ''
  }

  /**
   * Comparación constant-time del token de servidor.
   * Previene timing attacks.
   */
  private isServerToken(token: string): boolean {
    if (!this.ACCESS_SERVER || !token) return false
    try {
      const a = Buffer.from(token)
      const b = Buffer.from(this.ACCESS_SERVER)
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  /**
   * Verificar JWT localmente con HMAC-SHA256.
   * Soporta dos formatos de claims:
   * - Access token: { id, email, ... }
   * - Client token: { user, email, brand, ... }
   */
  private async verifyJwtLocal(token: string): Promise<any> {
    if (!this.JWT_SECRET) return null

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.JWT_SECRET,
      })

      // Access token (usuario normal)
      if (payload.id && payload.email) {
        return {
          id: payload.id,
          email: payload.email,
          name: payload.name || '',
          role: payload.role || 'user',
          isSuperAdmin: payload.isSuperAdmin || false,
          isVerificated: payload.isVerificated ?? true,
          status: payload.status || 'active',
          brand: payload.brand || null,
        }
      }

      // Client token (OAuth client)
      if (payload.user && payload.email) {
        return {
          id: payload.user,
          email: payload.email,
          name: payload.name || '',
          role: payload.role || 'user',
          isSuperAdmin: false,
          isVerificated: true,
          status: 'active',
          brand: payload.brand || null,
        }
      }

      return null
    } catch {
      // JWT inválido o expirado → fallback a auth service
      return null
    }
  }

  /**
   * Verificar token via backend-auth API.
   * Usa POST /auth/verify/token (como alerts-service).
   * Si falla, intenta GET /auth/me (como backend-platform).
   */
  private async verifyViaAuthService(token: string): Promise<any> {
    if (!this.SERVICE_AUTH) return null

    try {
      // Primero intentar POST /auth/verify/token (más completo)
      const verifyResponse = await fetch(`${this.SERVICE_AUTH}/auth/verify/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10000),
      })

      if (verifyResponse.ok) {
        const body = await verifyResponse.json()
        if (body.valid && body.user) {
          return {
            id: body.user.id,
            email: body.user.email,
            name: body.user.name || '',
            role: body.user.role || 'user',
            isSuperAdmin: body.user.isSuperAdmin || false,
            isVerificated: body.user.isVerificated ?? true,
            status: body.user.status || 'active',
          }
        }
        // Token válido pero sin user data → extraer claims del JWT
        if (body.valid) {
          return this.extractClaimsWithoutVerification(token)
        }
      }
    } catch {
      // /auth/verify/token no disponible, intentar /auth/me
    }

    try {
      // Fallback a GET /auth/me (compatibilidad con backend-platform)
      const meResponse = await fetch(`${this.SERVICE_AUTH}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      })

      if (meResponse.ok) {
        const body = await meResponse.json()
        if (body.error) return null

        const userData = body.data
          ? Array.isArray(body.data) ? body.data[0] : body.data
          : body

        if (userData?.id || userData?.email) {
          return {
            id: userData.id,
            email: userData.email,
            name: userData.name || '',
            role: userData.role || 'user',
            isSuperAdmin: userData.isSuperAdmin || false,
            isVerificated: userData.isVerificated ?? true,
            status: userData.status || 'active',
          }
        }
      }
    } catch {
      // auth service no disponible
    }

    return null
  }

  /**
   * Extraer claims del JWT sin verificar firma.
   * Solo se usa cuando auth service ya confirmó validez.
   */
  private extractClaimsWithoutVerification(token: string): any {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return null

      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      )

      const id = payload.id || payload.user
      const email = payload.email
      if (!id && !email) return null

      return {
        id: id || '',
        email: email || '',
        name: payload.name || '',
        role: payload.role || 'user',
        isSuperAdmin: payload.isSuperAdmin || false,
        isVerificated: true,
        status: 'active',
        brand: payload.brand || null,
      }
    } catch {
      return null
    }
  }
}
