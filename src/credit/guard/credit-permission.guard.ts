import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { timingSafeEqual } from 'crypto'
import { Request } from 'express'

import { RequestException } from '../../shared/exception/request.exception'
import { ClientRolesService } from '../../client/client-roles.service'
import { CREDIT_PERMISSION_KEY } from './require-credit-permission.decorator'

interface GuardUser {
  id: string
  isSuperAdmin: boolean
  brand?: string | null
}

/**
 * Autentica al usuario (cookie de sesión o Bearer JWT, o el ACCESS_SERVER) y, si
 * el handler declara `@RequireCreditPermission(slug)`, verifica el permiso efectivo
 * contra backend-roles. Las ops de crédito son fraude interno si no se gatean
 * (cargar buró `clear` habilita crédito). Fail-closed. Ver §8 del diseño.
 */
@Injectable()
export class CreditPermissionGuard implements CanActivate {
  private readonly COOKIE_SESSION = process.env.COOKIE_SESSION
  private readonly ACCESS_SERVER = process.env.ACCESS_SERVER
  private readonly JWT_SECRET = process.env.JWT_SECRET
  private readonly SERVICE_AUTH = process.env.SERVICE_AUTH || process.env.SERVER_AUTH

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly roles: ClientRolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: GuardUser }>()
    const user = await this.resolveUser(req)
    if (!user) {
      throw new RequestException({ error: 'unauthorized', code: 'unauthorized' }, HttpStatus.UNAUTHORIZED)
    }
    req.user = user

    const required = this.reflector.get<string>(CREDIT_PERMISSION_KEY, context.getHandler())
    if (!required) return true
    if (user.isSuperAdmin) return true

    const allowed = await this.roles.checkPermission(user.id, required)
    if (!allowed) {
      throw new RequestException(
        { error: 'forbidden', code: 'forbidden', permission: required },
        HttpStatus.FORBIDDEN,
      )
    }
    return true
  }

  private async resolveUser(req: Request): Promise<GuardUser | null> {
    const cookie = (req as any).cookies?.[this.COOKIE_SESSION as string]
    const token = cookie || this.extractBearer(req)
    if (!token) return null

    if (this.isServerToken(token)) return { id: 'server', isSuperAdmin: true, brand: null }

    // 1) Verificación local con el JWT_SECRET global (tokens admin/internos).
    try {
      const payload: any = this.jwt.verify(token, { secret: this.JWT_SECRET })
      const id = payload.id || payload.user
      if (id) return { id, isSuperAdmin: !!payload.isSuperAdmin, brand: payload.brand ?? null }
    } catch {
      /* sigue a la validación contra el auth-service */
    }

    // 2) Tokens de auto-login: firmados con el `clientSecret` del cliente (que
    // ROTA), así que payments NO puede guardarlo. Los valida el auth-service,
    // que conoce el secreto vigente de cada cliente. Ver backend-auth
    // POST /client/validate-token.
    return this.validateViaAuth(token)
  }

  /**
   * Valida el token de cliente contra el auth-service. El `client` se lee del
   * propio token (decode sin verificar firma) y el auth verifica con el
   * `clientSecret` vigente. Devuelve el usuario o null.
   */
  private async validateViaAuth(token: string): Promise<GuardUser | null> {
    if (!this.SERVICE_AUTH) return null
    const client = this.decodeClaims(token)?.client
    if (!client) return null

    try {
      const res = await fetch(`${this.SERVICE_AUTH}/client/validate-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ client }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return null
      const body: any = await res.json()
      if (body?.code !== 'tokenValidate' || !body?.data) return null
      const id = body.data.user || body.data.id
      if (!id) return null
      return {
        id,
        isSuperAdmin: body.data.role === 'superadmin' || !!body.data.isSuperAdmin,
        brand: body.data.brand ?? this.decodeClaims(token)?.brand ?? null,
      }
    } catch {
      return null
    }
  }

  /** Decodifica los claims del JWT sin verificar la firma (solo lectura). */
  private decodeClaims(token: string): any {
    try {
      return JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'))
    } catch {
      return null
    }
  }

  private extractBearer(req: Request): string {
    const auth = req.headers.authorization || ''
    const parts = auth.split(' ')
    return parts.length > 1 && parts[0].toLowerCase() === 'bearer' ? parts[1] : ''
  }

  private isServerToken(token: string): boolean {
    if (!this.ACCESS_SERVER || !token) return false
    try {
      const a = Buffer.from(token)
      const b = Buffer.from(this.ACCESS_SERVER)
      return a.length === b.length && timingSafeEqual(a, b)
    } catch {
      return false
    }
  }
}
