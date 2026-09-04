import { isProductionEnv, readConfioWebhookKey } from './confio-webhook-env'

/**
 * Capa 1: las dos lecturas de entorno, puras y sin Nest.
 *
 * Ningún caso toca `process.env`: las funciones reciben el entorno por
 * parámetro justamente para que el spec no dependa de —ni ensucie— el entorno
 * real del runner.
 */
describe('readConfioWebhookKey', () => {
  it('devuelve null cuando la variable no está definida', () => {
    expect(readConfioWebhookKey({})).toBeNull()
  })

  it('devuelve null cuando la variable está vacía', () => {
    expect(readConfioWebhookKey({ CONFIO_WEBHOOK_KEY: '' })).toBeNull()
  })

  // Mutación que lo pone rojo: sacar la cláusula `!== 'CHANGEME'`.
  it('trata CHANGEME como NO configurada, igual que confio.provider.ts:110', () => {
    expect(readConfioWebhookKey({ CONFIO_WEBHOOK_KEY: 'CHANGEME' })).toBeNull()
  })

  it('devuelve la clave tal cual cuando está configurada', () => {
    expect(readConfioWebhookKey({ CONFIO_WEBHOOK_KEY: 'abc123' })).toBe('abc123')
  })
})

describe('isProductionEnv', () => {
  // Mutación que lo pone rojo: sacar `ENV === 'production'` de la disyunción.
  // Es la grafía que este servicio USA de verdad (.env.schema:3, entrypoint.sh).
  it('es producción con ENV sola', () => {
    expect(isProductionEnv({ ENV: 'production' })).toBe(true)
  })

  // Mutación que lo pone rojo: sacar `GO_ENV === 'production'`.
  it('es producción con GO_ENV sola', () => {
    expect(isProductionEnv({ GO_ENV: 'production' })).toBe(true)
  })

  // Mutación que lo pone rojo: sacar `NODE_ENV === 'production'`.
  it('es producción con NODE_ENV sola', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true)
  })

  it('no es producción en staging, en development ni con el entorno vacío', () => {
    expect(isProductionEnv({ ENV: 'staging' })).toBe(false)
    expect(isProductionEnv({ ENV: 'development' })).toBe(false)
    expect(isProductionEnv({})).toBe(false)
  })
})
