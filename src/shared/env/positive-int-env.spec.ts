import { TasksService } from '../../tasks/tasks.service'
import { positiveIntEnv } from './positive-int-env'

const NAME = 'LOC348_PROBE_COUNT'

describe('positiveIntEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it.each([undefined, '', '   '])('returns the fallback when the variable is %j', (raw) => {
    // R15: red when an unset or blank variable throws instead of falling back.
    if (raw === undefined) delete process.env[NAME]
    else process.env[NAME] = raw

    expect(positiveIntEnv(NAME, 3)).toBe(3)
  })

  it('reads a whole number of at least 1', () => {
    // R15: red when positiveIntEnv stops trimming the value: ' 5 ' throws instead of reading 5.
    process.env[NAME] = ' 5 '

    expect(positiveIntEnv(NAME, 3)).toBe(5)
  })

  it.each(['abc', '1.5', '-2', '0', '1e3', '3days'])('throws naming the variable for %j', (raw) => {
    // Mutation (all rows): positiveIntEnv returns `parseInt(raw)` without the check -> no throw, red.
    process.env[NAME] = raw

    expect(() => positiveIntEnv(NAME, 3)).toThrow(`Invalid environment variable ${NAME}`)
  })

  it('keeps TasksService from being built with a MAX_PAYMENT_RETRY_COUNT that is not a number', () => {
    // R15: red when tasks.service.ts goes back to `parseInt(process.env.MAX_PAYMENT_RETRY_COUNT || '3')`.
    process.env.MAX_PAYMENT_RETRY_COUNT = 'abc'
    const Tasks = TasksService as unknown as new () => TasksService

    expect(() => new Tasks()).toThrow('Invalid environment variable MAX_PAYMENT_RETRY_COUNT')
  })
})
