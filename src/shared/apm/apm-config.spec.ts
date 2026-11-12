import * as fs from 'fs'
import * as path from 'path'

import { loadApmAgent } from './apm-agent'

// R17: loading the real agent starts it, and it reports to New Relic, an external paid service.
const mockNewRelicLoads = jest.fn()
const mockNewRelicAgent = { recordCustomEvent: jest.fn() }
jest.mock('newrelic', () => {
  mockNewRelicLoads()
  return mockNewRelicAgent
})

/**
 * The New Relic agent takes its identity and licence from the environment: a name pinned in a
 * script would merge every environment into one app. Without a licence the service starts and
 * the code never loads the package.
 */
const ROOT = path.resolve(__dirname, '..', '..', '..')
const AGENT_VARS = ['NEW_RELIC_APP_NAME', 'NEW_RELIC_LICENSE_KEY'] as const
const scripts = (): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts

describe('New Relic agent configuration', () => {
  beforeEach(() => {
    jest.resetModules()
    mockNewRelicLoads.mockClear()
  })

  it.each(['start:prod', 'start:stag'])('%s preloads the agent', (script) => {
    // R15: red when either script goes back to plain node: that environment never reports.
    expect(scripts()[script]).toMatch(/^node -r newrelic /)
  })

  it('pins neither the app name nor the licence in any npm script', () => {
    // R15: red when a script sets NEW_RELIC_APP_NAME=…: every environment reports as one app.
    const pinned = Object.entries(scripts()).flatMap(([name, body]) =>
      AGENT_VARS.filter((v) => body.includes(`${v}=`)).map((v) => `${name}: ${v}`),
    )

    expect(pinned).toEqual([])
  })

  it('declares both agent variables in the env schema, the licence as sensitive', () => {
    // R15: red when the licence entry loses `sensitive: true`: it would be printed as plain config.
    const schema = fs.readFileSync(path.join(ROOT, '.env.schema'), 'utf8')
    const licence = schema.split('NEW_RELIC_LICENSE_KEY:')[1]?.split(/\n\s*\n/)[0] ?? ''

    expect(AGENT_VARS.filter((v) => !schema.includes(`  ${v}:`))).toEqual([])
    expect(licence).toMatch(/sensitive: true/)
  })

  it('without a licence the agent records nothing and newrelic is never loaded', () => {
    // R15: red when the licence check goes: the package is required with no licence.
    const agent = loadApmAgent({})

    expect(() => agent.recordCustomEvent('DropiRecharge', { tokens: 1 })).not.toThrow()
    expect(mockNewRelicLoads).not.toHaveBeenCalled()
  })

  it('with a licence the agent is the one newrelic exports', () => {
    // R15: red when the agent is always silent: nothing is sent with a licence set.
    const agent = loadApmAgent({ NEW_RELIC_LICENSE_KEY: 'licence-of-the-case' })

    expect(mockNewRelicLoads).toHaveBeenCalledTimes(1)
    expect(agent).toBe(mockNewRelicAgent)
  })
})
