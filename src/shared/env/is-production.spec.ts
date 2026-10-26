import { ConfioProvider } from '../../provider/confio/confio.provider'

/**
 * Production detection in `isProductionEnv` checks `ENV === 'production'`
 * alongside legacy `GO_ENV` and `NODE_ENV` because `.env.schema`,
 * `.env-template`, and `entrypoint.sh` only define `ENV`.
 *
 * `validateWebhookSignature` rejects missing `CONFIO_ACCESS_TOKEN` in every
 * environment without consulting `isProductionEnv`, while `ConfioProvider`
 * (`baseUrl`) and `logger` (console transport) branch on `isProductionEnv`.
 */
describe('isProductionEnv — sus tres consumidores', () => {
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    env = { ...process.env }
    delete process.env.ENV
    delete process.env.GO_ENV
    delete process.env.NODE_ENV
    delete process.env.CONFIO_API_BASE_URL
    delete process.env.CONFIO_STORE_ID
    delete process.env.CONFIO_ACCESS_TOKEN
  })

  afterEach(() => {
    process.env = env
    jest.resetModules()
  })

  describe('la firma del webhook no hace fail-open', () => {
    // Mutation M1: return true when `!this.accessToken` in validateWebhookSignature
    // (failing open when no token is configured) turns this block red.
    it('con ENV=production y sin token, rechaza la firma', () => {
      process.env.ENV = 'production'

      const provider = new ConfioProvider()

      expect(provider.validateWebhookSignature(Buffer.from('{}'), 'firma-inventada')).toBe(false)
    })

    it('rejects the webhook signature in development when no token is configured', () => {
      process.env.ENV = 'development'

      const provider = new ConfioProvider()

      expect(provider.validateWebhookSignature(Buffer.from('{}'), 'firma-inventada')).toBe(false)
    })

    it.each(['GO_ENV', 'NODE_ENV'])(
      'sigue reconociendo %s=production, que era la grafía vieja',
      (variable) => {
        process.env[variable] = 'production'

        const provider = new ConfioProvider()

        expect(provider.validateWebhookSignature(Buffer.from('{}'), 'x')).toBe(false)
      },
    )
  })

  describe('la URL base por defecto', () => {
    // Mutación M2: dejar el predicado viejo en el constructor → rojo. Con ENV
    // producción apuntaba al Confío de DEV.
    it('con ENV=production resuelve la de producción', () => {
      process.env.ENV = 'production'

      expect(new ConfioProvider()['baseUrl']).toBe('https://api.confiopagos.com/v1')
    })

    it('fuera de producción sigue resolviendo la de dev', () => {
      process.env.ENV = 'staging'

      expect(new ConfioProvider()['baseUrl']).toBe('https://api.dev.confiopagos.com/v1')
    })

    // La variable explícita sigue mandando sobre el default, como hasta ahora.
    it('CONFIO_API_BASE_URL le gana al default', () => {
      process.env.ENV = 'production'
      process.env.CONFIO_API_BASE_URL = 'http://confio.test/v1'

      expect(new ConfioProvider()['baseUrl']).toBe('http://confio.test/v1')
    })
  })

  describe('el transport de consola del logger', () => {
    const cargarLogger = () => {
      let cargado
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules exige require: un import estático se cachearía y el módulo no se re-evaluaría con el ENV del caso
        cargado = require('../logger/logger').logger
      })
      return cargado
    }

    // Por nombre de constructor y NO con `instanceof transports.Console`:
    // `jest.isolateModules` carga su propia copia de winston, así que la clase
    // de adentro y la de afuera son objetos distintos y el `instanceof` daría
    // false SIEMPRE — el caso pasaría en verde sin comprobar nada.
    const tieneConsola = (l) => l.transports.some((t) => t.constructor.name === 'Console')

    // Mutación M3: dejar el `NODE_ENV !== 'production'` de antes → rojo. Con
    // ENV=production el proceso escribía a consola con formato para humanos.
    it('no se agrega con ENV=production', () => {
      process.env.ENV = 'production'

      expect(tieneConsola(cargarLogger())).toBe(false)
    })

    it('se agrega fuera de producción', () => {
      process.env.ENV = 'development'

      expect(tieneConsola(cargarLogger())).toBe(true)
    })
  })
})
