import type { SessionPerson } from '../../src/shared/auth/session-verifier.service'

/**
 * Stands in for `SessionVerifier` in tests about what a route does with a person.
 * R17: auth is another service and does not run in this container; the session cases
 * themselves run against a fake auth server in `api-auth.guard.session.spec.ts`.
 *
 * Like auth, it knows only the sessions it issued and answers null to any other token.
 * `isSuperAdmin` is what the test says the account is, as auth reads it from its database.
 */
export function authSessionsDouble() {
  const issued = new Map<string, SessionPerson>()
  return {
    sign(person: { id: string; isSuperAdmin?: boolean; brand?: string | null }): string {
      const token = `session-double.${person.id}.${issued.size + 1}`
      issued.set(token, {
        id: person.id,
        isSuperAdmin: person.isSuperAdmin === true,
        brand: person.brand ?? null,
      })
      return token
    },
    async verify(token: string): Promise<SessionPerson | null> {
      return issued.get(token) ?? null
    },
  }
}
