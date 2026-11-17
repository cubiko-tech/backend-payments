/**
 * The stored key of a movement an admin asked for: the body key under `admin:`. Keys of internal
 * movements (`payment:<id>:…`) share the same unique index, so an admin key can never take one.
 */
export const adminIdempotencyKey = (key: string) => `admin:${key}`
