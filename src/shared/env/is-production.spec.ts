import * as fs from 'fs'
import * as path from 'path'
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

  describe('service risk documentation and contract comments (LOC-36)', () => {
    const repoRoot = path.resolve(__dirname, '../../..')
    const closedRiskTitles = [
      'Una recarga de wallet acredita también el impuesto como saldo (C1)',
      'Completar un pago externo puede acreditar dos veces (C2)',
      'El cobro y el crédito de wallet no tienen llave de idempotencia (C2)',
      'Un pago de servicio puede debitar una wallet de otra moneda o de tokens (C3)',
      '`WalletService.debit` no exige `walletId` ni pertenencia de la wallet a la marca (C3)',
      'La renovación por wallet pide precio fijo en COP, omite la moneda en `debit` y `processWalletPayment` oculta fallos del débito (C3)',
    ]

    it('keeps every docs/RIESGOS.md anchor pointing to existing symbols and no closed entry marked open', () => {
      const risksDoc = fs.readFileSync(path.join(repoRoot, 'docs/RIESGOS.md'), 'utf8')
      const sections = risksDoc.split(/^## /m).slice(1)
      const headingsFound = new Set<string>()

      for (const section of sections) {
        const heading = section.split('\n')[0].trim()
        headingsFound.add(heading)

        const estadoParts = section.split('- **Estado**:')
        expect(estadoParts.length).toBe(2)
        const estadoText = estadoParts[1].trim()

        if (closedRiskTitles.includes(heading)) {
          expect(estadoText).not.toMatch(/^abiert[oa]\b/i)
        }

        const dondeMatch = section.match(/- \*\*Dónde\*\*:\s*([\s\S]*?)(?=\n- \*\*|$)/)
        expect(dondeMatch).not.toBeNull()
        const dondeClauses = dondeMatch![1].split(';')

        for (const clause of dondeClauses) {
          let currentFile: string | null = null
          const pendingSymbols: string[] = []
          const fileSymbols = new Map<string, string[]>()
          const tokenRegex = /`([^`]+)`/g
          let tokenMatch: RegExpExecArray | null

          while ((tokenMatch = tokenRegex.exec(clause)) !== null) {
            const token = tokenMatch[1]
            const fileAnchorMatch = token.match(/^(src\/[^:]+):(\d+)(?:-(\d+))?$/)
            if (fileAnchorMatch) {
              currentFile = fileAnchorMatch[1]
              if (!fileSymbols.has(currentFile)) {
                fileSymbols.set(currentFile, [])
              }
              if (pendingSymbols.length > 0) {
                fileSymbols.get(currentFile)!.push(...pendingSymbols.splice(0))
              }
              continue
            }
            if (/^:\d+(?:-\d+)?$/.test(token)) {
              continue
            }
            if (currentFile) {
              fileSymbols.get(currentFile)!.push(token)
            } else {
              pendingSymbols.push(token)
            }
          }

          expect(fileSymbols.size).toBeGreaterThan(0)
          for (const [relativeFile, symbols] of fileSymbols.entries()) {
            const filePath = path.join(repoRoot, relativeFile)
            expect(fs.existsSync(filePath)).toBe(true)
            const fileContent = fs.readFileSync(filePath, 'utf8')
            for (const symbol of symbols) {
              expect(fileContent).toContain(symbol)
            }
          }
        }
      }

      for (const closedTitle of closedRiskTitles) {
        expect(headingsFound.has(closedTitle)).toBe(true)
      }
    })

    it('keeps comments on isProductionEnv, WalletService.debit, and assertWalletCurrency aligned with the contract in English', () => {
      const isProductionSource = fs.readFileSync(
        path.join(repoRoot, 'src/shared/env/is-production.ts'),
        'utf8',
      )
      expect(isProductionSource).not.toContain('confio.provider.ts:511')
      expect(isProductionSource).not.toContain('NO lo toca')
      expect(isProductionSource).toContain("configured as `'production'`")

      const walletSource = fs.readFileSync(
        path.join(repoRoot, 'src/wallet/wallet.service.ts'),
        'utf8',
      )
      expect(walletSource).not.toContain('no tiene guarda propia')
      expect(walletSource).not.toContain('el cron sigue llamando con 3 argumentos')
      expect(walletSource).toContain(
        'Atomically debits `amount` from `walletId` under a `pessimistic_write` row lock',
      )

      const checkoutSource = fs.readFileSync(
        path.join(repoRoot, 'src/checkout/checkout.service.ts'),
        'utf8',
      )
      expect(checkoutSource).not.toContain('Acotado a `plan_purchase`')
      expect(checkoutSource).not.toContain('quedan fuera del alcance de esta tarea')
      expect(checkoutSource).toContain(
        'Validates that the wallet referenced by `req` can settle a checkout in `currency`',
      )
    })
  })
})
