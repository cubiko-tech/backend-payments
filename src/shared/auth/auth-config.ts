/**
 * Where payments reaches backend-auth and how long it waits for it, read by the session verifier
 * and the guard from this one place. The URL comes from `SERVICE_AUTH`, or `SERVER_AUTH` when the
 * first is empty; read at call time so each caller sees the environment it was built in.
 */
export function authBaseUrl(): string | undefined {
  return process.env.SERVICE_AUTH || process.env.SERVER_AUTH
}

/** How long a session check waits for auth when the route sets no timeout of its own. */
export const SESSION_CHECK_TIMEOUT_MS = 5000

/** How long an auto-login token check waits for auth when the route sets no timeout of its own. */
export const AUTO_LOGIN_CHECK_TIMEOUT_MS = 10000
