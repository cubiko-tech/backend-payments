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

    it('keeps every docs/RIESGOS.md anchor pointing to the named line and no closed entry marked open', () => {
      const risksDoc = fs.readFileSync(path.join(repoRoot, 'docs/RIESGOS.md'), 'utf8')
      const sections = risksDoc.split(/^## /m).slice(1)

      expect(sections.length).toBeGreaterThanOrEqual(9)

      for (const section of sections) {
        const heading = section.split('\n')[0].trim()
        const estadoParts = section.split('- **Estado**:')
        expect(estadoParts.length).toBe(2)
        const estadoText = estadoParts[1].trim()
        expect(estadoText).not.toMatch(/^abiert[oa]\b/i)

        let currentFile: string | null = null
        const tokenRegex = /`(src\/[^`:]+):(\d+)(?:-(\d+))?`|`:(\d+)(?:-(\d+))?`/g
        let match: RegExpExecArray | null
        const anchors: Array<{ file: string; start: number; end: number }> = []

        while ((match = tokenRegex.exec(section)) !== null) {
          if (match[1]) {
            currentFile = match[1]
            const start = Number(match[2])
            const end = match[3] ? Number(match[3]) : start
            anchors.push({ file: currentFile, start, end })
          } else if (currentFile && match[4]) {
            const start = Number(match[4])
            const end = match[5] ? Number(match[5]) : start
            anchors.push({ file: currentFile, start, end })
          }
        }

        expect(anchors.length).toBeGreaterThan(0)
        for (const anchor of anchors) {
          const filePath = path.join(repoRoot, anchor.file)
          expect(fs.existsSync(filePath)).toBe(true)
          const fileLines = fs.readFileSync(filePath, 'utf8').split('\n')
          expect(anchor.start).toBeGreaterThanOrEqual(1)
          expect(anchor.end).toBeGreaterThanOrEqual(anchor.start)
          expect(anchor.end).toBeLessThanOrEqual(fileLines.length)

          const snippet = fileLines
            .slice(anchor.start - 1, anchor.end)
            .join('\n')
            .trim()
          expect(snippet.length).toBeGreaterThan(0)
        }

        if (heading.includes('LOC-14') || heading.includes('LOC-16')) {
          expect(estadoText).toMatch(/mitigado/i)
          expect(estadoText).toMatch(/Abierto/i)
        }
      }

      const walletLines = fs
        .readFileSync(path.join(repoRoot, 'src/wallet/wallet.service.ts'), 'utf8')
        .split('\n')
      expect(walletLines[189]).toContain('async debit(')
      expect(walletLines.slice(244, 255).join('\n')).toContain("walletCurrency === 'TKN'")

      const checkoutLines = fs
        .readFileSync(path.join(repoRoot, 'src/checkout/checkout.service.ts'), 'utf8')
        .split('\n')
      expect(checkoutLines.slice(210, 213).join('\n')).toContain('assertWalletCurrency')
      expect(checkoutLines[1057]).toContain('private async assertWalletCurrency(')

      const tasksLines = fs
        .readFileSync(path.join(repoRoot, 'src/tasks/tasks.service.ts'), 'utf8')
        .split('\n')
      expect(tasksLines[1122]).toContain('private async renewFromWallet(')
      expect(tasksLines[1412]).toContain('private async extendSubscriptionPeriod(')
      expect(tasksLines[1460]).toContain('private isPostponementGraceExceeded(')
      expect(tasksLines[1472]).toContain('private async acquireSubscriptionLock(')
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
