/**
 * Returns `true` when `env` is configured as `'production'` through `ENV`,
 * `GO_ENV`, or `NODE_ENV` (`ENV` is canonical in `.env.schema` and `entrypoint.sh`).
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENV === 'production' || env.GO_ENV === 'production' || env.NODE_ENV === 'production'
}
