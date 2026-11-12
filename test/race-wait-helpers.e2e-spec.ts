import { DataSource } from 'typeorm'
import {
  raceConnectionOptions,
  someoneWaitsOnAdvisoryLock,
  someoneWaitsOnRowLock,
} from './support/wallet-race.fixture'

// Advisory keys used only here, so no other suite contends for them.
const FOREIGN_KEY = 160001
const OWN_KEY = 160002
const SHORT_WAIT_MS = 500

describe('Race wait helpers count only the sessions of their own suite (PostgreSQL, LOC-160)', () => {
  let suite: DataSource
  let otherSuite: DataSource

  beforeAll(async () => {
    suite = await new DataSource(raceConnectionOptions()).initialize()
    otherSuite = await new DataSource({
      ...raceConnectionOptions(),
      applicationName: 'roax-e2e-other-suite',
    }).initialize()
  })

  afterAll(async () => {
    await suite?.destroy()
    await otherSuite?.destroy()
  })

  async function isBlocked(pid: number) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const rows = await suite.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pid])
      if (rows.length > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  /** Blocks a session of `waiterSource` on advisory `key`, held by this suite, and runs `check`. */
  async function withBlockedSession(
    waiterSource: DataSource,
    key: number,
    check: () => Promise<void>,
  ) {
    const holder = suite.createQueryRunner()
    const waiter = waiterSource.createQueryRunner()
    let blocked: Promise<unknown> | undefined
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [key])
      const [{ pid }] = await waiter.query('SELECT pg_backend_pid() AS pid')
      blocked = waiter.query('SELECT pg_advisory_lock($1)', [key])
      expect(await isBlocked(pid)).toBe(true)
      await check()
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [key])
      if (blocked) {
        await blocked
        await waiter.query('SELECT pg_advisory_unlock($1)', [key])
      }
      await holder.release()
      await waiter.release()
    }
  }

  it('the advisory helper ignores a session of another suite blocked on the same database', async () => {
    // R15: red when the advisory helper counts any session of the database: it returns true.
    await withBlockedSession(otherSuite, FOREIGN_KEY, async () => {
      expect(await someoneWaitsOnAdvisoryLock(suite, SHORT_WAIT_MS)).toBe(false)
    })
  })

  it('the row lock helper ignores a session of another suite blocked on the same database', async () => {
    // R15: red when the row lock helper counts any session of the database: it returns true.
    await withBlockedSession(otherSuite, FOREIGN_KEY, async () => {
      expect(await someoneWaitsOnRowLock(suite, SHORT_WAIT_MS)).toBe(false)
    })
  })

  it('the advisory helper sees a blocked session of its own suite', async () => {
    // R15: red when the advisory helper filters on a name its own sessions do not carry.
    const ownInstance = await new DataSource(raceConnectionOptions()).initialize()
    try {
      await withBlockedSession(ownInstance, OWN_KEY, async () => {
        expect(await someoneWaitsOnAdvisoryLock(suite)).toBe(true)
      })
    } finally {
      await ownInstance.destroy()
    }
  })

  it('the row lock helper sees a blocked session of its own suite', async () => {
    // R15: red when the row lock helper filters on a name its own sessions do not carry.
    const ownInstance = await new DataSource(raceConnectionOptions()).initialize()
    try {
      await withBlockedSession(ownInstance, OWN_KEY, async () => {
        expect(await someoneWaitsOnRowLock(suite)).toBe(true)
      })
    } finally {
      await ownInstance.destroy()
    }
  })

  it('refuses a connection that does not carry a suite name', async () => {
    // R15: red when a nameless connection is accepted: it would match sessions with an empty name.
    const nameless = await new DataSource({
      ...raceConnectionOptions(),
      applicationName: undefined,
    }).initialize()
    try {
      await expect(someoneWaitsOnAdvisoryLock(nameless, SHORT_WAIT_MS)).rejects.toThrow(
        'raceConnectionOptions',
      )
    } finally {
      await nameless.destroy()
    }
  })
})
