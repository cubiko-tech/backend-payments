import { HttpStatus, Injectable } from '@nestjs/common'

import { RequestException } from '../exception/request.exception'
import { logger } from '../logger/logger'

/** A person whose web session auth has just confirmed as live and active. */
export interface SessionPerson {
  id: string
  isSuperAdmin: boolean
  brand: string | null
}

const SESSION_TYPE = 'session'
const WEB_SESSION_AUDIENCE = 'web-session'
const SESSION_ALGORITHMS = new Set(['EdDSA', 'HS256'])
const DEFAULT_TIMEOUT_MS = 5000
const BASE64URL = /^[A-Za-z0-9_-]+$/

export const authUnavailable = () =>
  new RequestException(
    { code: 'AUTH_UNAVAILABLE', message: 'The user token cannot be checked right now' },
    HttpStatus.SERVICE_UNAVAILABLE,
  )

/**
 * Resolves a person's session token through auth's single verification point
 * (`GET /auth/validate`), which checks the signature (EdDSA by `kid`, or HS256 while epic 031
 * lasts), that the session is still open and that the account is active. Payments verifies no
 * person with a key of its own: identity and `isSuperAdmin` come from auth's answer.
 *
 * Before the network, only a base64url token shaped as a web session with its `sid` goes on; a
 * refresh, an MCP token or a hand-made JWT without a session is refused here. Auth not answering,
 * or answering anything but a verdict on the token (429, 5xx, another 4xx), is a 503 logged as a
 * `warn` with its cause and never the token: a 401 would log the person out for an outage.
 */
@Injectable()
export class SessionVerifier {
  private readonly authUrl = process.env.SERVICE_AUTH || process.env.SERVER_AUTH

  async verify(token: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SessionPerson | null> {
    const claims = readSessionClaims(token)
    if (!claims) return null
    if (!this.authUrl) {
      logger.warn('Session check unavailable: SERVICE_AUTH is not configured')
      throw authUnavailable()
    }

    const signal = AbortSignal.timeout(timeoutMs)
    let res: globalThis.Response
    try {
      res = await fetch(`${this.authUrl}/auth/validate`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
    } catch (error) {
      logger.warn(`Session check unavailable: auth unreachable (${(error as Error)?.name})`)
      throw authUnavailable()
    }
    if (!res.ok) {
      // Drop the unread body so the connection does not wait on it.
      await res.body?.cancel().catch(() => undefined)
      if (res.status === HttpStatus.UNAUTHORIZED || res.status === HttpStatus.FORBIDDEN) return null
      logger.warn(`Session check unavailable: auth answered ${res.status}`)
      throw authUnavailable()
    }

    let body: any
    try {
      body = await res.json()
    } catch {
      logger.warn('Session check unavailable: auth answered an unreadable body')
      throw authUnavailable()
    }
    const user = body?.user
    if (body?.valid !== true || user?.id !== claims.id || user?.status !== 'active') return null
    return {
      id: user.id,
      isSuperAdmin: user.isSuperAdmin === true,
      brand: typeof claims.brand === 'string' ? claims.brand : null,
    }
  }
}

/** The unverified claims of a web session token, or null when the token is not one. */
function readSessionClaims(token: string): Record<string, any> | null {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return null
  // fetch refuses to build a header with CR/LF, which would read as auth being down.
  if (![header, payload, signature].every((segment) => BASE64URL.test(segment))) return null
  let alg: unknown
  let claims: any
  try {
    alg = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))?.alg
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const isSession =
    SESSION_ALGORITHMS.has(alg as string) &&
    claims?.typ === SESSION_TYPE &&
    claims?.aud === WEB_SESSION_AUDIENCE &&
    typeof claims?.id === 'string' &&
    claims.id.length > 0 &&
    typeof claims?.sid === 'string' &&
    claims.sid.length > 0
  return isSession ? claims : null
}
