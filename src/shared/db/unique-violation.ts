/** Postgres unique-index violation (`code=23505`), as the driver error reaches a repository call. */
export function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505'
}
