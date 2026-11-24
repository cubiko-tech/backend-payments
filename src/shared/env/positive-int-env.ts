/**
 * Reads `name` as a whole number of at least 1: unset or blank gives `fallback`, anything else that is
 * not only digits (`abc`, `1.5`, `-2`, `0`) throws naming the variable, so the service refuses to start
 * instead of running with a `NaN` that turns every comparison against it false.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN
  if (!(value >= 1) || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid environment variable ${name}: expected a whole number of at least 1`)
  }
  return value
}
