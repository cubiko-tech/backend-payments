import { generateKeyPairSync, sign, verify } from 'crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { JwtService } from '@nestjs/jwt'

export interface FakeAuthAccount {
  id: string
  isSuperAdmin: boolean
  status: 'active' | 'inactive'
}

const KID = 'test-ed25519'
const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * A stand-in for backend-auth's `GET /v1/auth/validate`, served over HTTP so the guard runs its
 * real client. R17: auth does not run in this container. It follows
 * `session-validation.service.ts` of auth: EdDSA by `kid` (a test Ed25519 key) or HS256 with
 * `JWT_SECRET`, only `typ: session` + `aud: web-session`, a `sid` must name a live session of
 * that user (a token without `sid` is accepted, as auth does), and the account must be active.
 * `isSuperAdmin` comes from the account, never from the token.
 */
export async function startFakeAuth(jwtSecret: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const hs256 = new JwtService({ secret: jwtSecret })
  const accounts = new Map<string, FakeAuthAccount>()
  const liveSessions = new Map<string, string>()
  const requests: string[] = []
  let forced: { status: number; body?: unknown } | 'stall' | null = null
  let sessionCount = 0

  const verifyToken = (token: string): any => {
    const [header, payload, signature] = token.split('.')
    try {
      const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
      if (alg === 'HS256') return hs256.verify(token)
      if (alg !== 'EdDSA' || kid !== KID) return null
      const signed = verify(
        null,
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      )
      return signed ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : null
    } catch {
      return null
    }
  }

  const answer = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`)
    if (forced === 'stall') return
    if (forced) return answer(res, forced.status, forced.body)
    if (req.method !== 'GET' || req.url !== '/auth/v1/auth/validate') return answer(res, 404)

    const [scheme, token] = (req.headers.authorization || '').split(' ')
    const claims = scheme?.toLowerCase() === 'bearer' && token ? verifyToken(token) : null
    const unauthorized = { code: 'unauthorized', error: 'Unauthorized', status: 401 }
    if (!claims || claims.typ !== 'session' || claims.aud !== 'web-session') {
      return answer(res, 401, unauthorized)
    }
    if (claims.sid && liveSessions.get(claims.sid) !== claims.id)
      return answer(res, 401, unauthorized)
    const account = accounts.get(claims.id)
    if (!account || account.status !== 'active') return answer(res, 401, unauthorized)
    answer(res, 200, {
      valid: true,
      user: { id: account.id, isSuperAdmin: account.isSuperAdmin, status: account.status },
      expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
    })
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const signEdDsa = (claims: Record<string, unknown>) => {
    const input = `${b64u({ alg: 'EdDSA', typ: 'JWT', kid: KID })}.${b64u(claims)}`
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`
  }
  const withTimes = (claims: Record<string, unknown>) => {
    const iat = Math.floor(Date.now() / 1000)
    return { iat, exp: iat + 3600, ...claims }
  }

  return {
    url: `http://127.0.0.1:${port}/auth/v1`,
    requests,
    addAccount(account: FakeAuthAccount) {
      accounts.set(account.id, { ...account })
    },
    deactivate(id: string) {
      accounts.get(id).status = 'inactive'
    },
    /** Opens a session as auth's login does: the EdDSA `session_token` and the HS256 cookie `token`. */
    login(id: string, extra: Record<string, unknown> = {}) {
      sessionCount += 1
      const sid = `sid-${sessionCount}`
      liveSessions.set(sid, id)
      const claims = withTimes({ id, sid, typ: 'session', aud: 'web-session', ...extra })
      return { sid, sessionToken: signEdDsa(claims), cookieToken: hs256.sign(claims) }
    },
    /** Any token signed with auth's Ed25519 key: a refresh, an MCP token. */
    signWithAuthKey(claims: Record<string, unknown>) {
      return signEdDsa(withTimes(claims))
    },
    /** Back to answering by the rules, with no request seen. */
    reset() {
      forced = null
      requests.length = 0
    },
    answerWith(status: number, body?: unknown) {
      forced = { status, body }
    },
    stall() {
      forced = 'stall'
    },
    async stop() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export type FakeAuth = Awaited<ReturnType<typeof startFakeAuth>>
