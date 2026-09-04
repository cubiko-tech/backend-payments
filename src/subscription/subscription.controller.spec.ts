import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'

import { SubscriptionController } from './subscription.controller'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequestException } from '../shared/exception/request.exception'

/**
 * Los CUATRO endpoints que resuelven la marca del principal van en una sola tabla a
 * propósito: la regla de resolución es una, y si mañana se agrega otro que se saltee
 * `resolveBrandId`, el que lo agregue tiene que sumarlo acá o el spec deja de cubrir
 * el endpoint nuevo de forma visible.
 *
 * `confirm` es el único que ESCRIBE —puede dejar la fila viva y asignar el plan en
 * roles—, y por eso está acá y no aparte: que escriba lo hace MÁS importante, no
 * menos, que la marca no salga nunca del query de un usuario.
 */
const READS = [['getCurrent'], ['getAcceptanceLink'], ['getHistory'], ['confirm']] as const

const SERVER_PRINCIPAL = { id: 'server', isSuperAdmin: true, brand: null }
const USER_WITH_BRAND = { id: 'u1', isSuperAdmin: false, brand: 'A' }
const USER_WITHOUT_BRAND = { id: 'u1', isSuperAdmin: false, brand: null }

describe('SubscriptionController — marca del principal en las lecturas', () => {
  let controller: SubscriptionController
  let service: Record<string, jest.Mock>

  /**
   * Se afirma sobre el `code` y el status, NUNCA sobre el texto del mensaje: el
   * cuerpo es lo que ve el cliente y el campo estable del contrato es `code`.
   */
  async function expectRequestException(promise: Promise<unknown>, code: string, status: HttpStatus) {
    await expect(promise).rejects.toBeInstanceOf(RequestException)
    await promise.catch((error: RequestException) => {
      expect(error.getStatus()).toBe(status)
      expect(error.getResponse()).toMatchObject({ code })
    })
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        {
          provide: SubscriptionService,
          useValue: {
            getCurrent: jest.fn().mockResolvedValue({ data: {} }),
            getAcceptanceLink: jest.fn().mockResolvedValue({ data: {} }),
            getHistory: jest.fn().mockResolvedValue({ data: [] }),
            confirm: jest.fn().mockResolvedValue({ data: {}, confirmed: false }),
          },
        },
        { provide: EnterprisePricingService, useValue: {} },
      ],
    })
      // El controller está detrás de `ApiAuthGuard`, que inyecta `JwtService` y
      // `ClientRolesService`. Este spec prueba la LÓGICA del controller —de dónde
      // sale el `brandId` con el que se llama al servicio—, no la autenticación:
      // eso vive en `shared/auth/api-auth.guard.spec.ts`. Sin el override Nest
      // falla al resolver `JwtService` en el módulo de test.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<SubscriptionController>(SubscriptionController)
    service = module.get(SubscriptionService)
  })

  it.each(READS)('%s: el principal de servicio sí puede nombrar la marca por query', async (method) => {
    await controller[method]('B', { user: { ...SERVER_PRINCIPAL } })

    expect(service[method]).toHaveBeenCalledWith('B')
  })

  it.each(READS)('%s: el principal de servicio sin brandId da 400 y no consulta', async (method) => {
    await expectRequestException(
      controller[method](undefined as unknown as string, { user: { ...SERVER_PRINCIPAL } }),
      'BRAND_ID_REQUIRED',
      HttpStatus.BAD_REQUEST,
    )

    expect(service[method]).not.toHaveBeenCalled()
  })

  it.each(READS)('%s: al usuario se le lee SU marca y el query se ignora', async (method) => {
    await controller[method]('B', { user: { ...USER_WITH_BRAND } })

    expect(service[method]).toHaveBeenCalledWith('A')
    // Esta segunda aserción es la que rompe la mutación (volver el handler a
    // `this.subscriptionService.X(brandId)`): sin ella, un handler que pasara la
    // marca del query igual podría verse verde si alguien relajara la primera.
    expect(service[method]).not.toHaveBeenCalledWith('B')
  })

  it.each(READS)('%s: el usuario sin marca da 403 forbidden y no consulta', async (method) => {
    await expectRequestException(
      controller[method]('B', { user: { ...USER_WITHOUT_BRAND } }),
      'forbidden',
      HttpStatus.FORBIDDEN,
    )

    expect(service[method]).not.toHaveBeenCalled()
  })
})

/**
 * `POST /subscription/paid` es una ESCRITURA, y como el resto de las escrituras del
 * controller recibe la marca por body — `resolveBrandId` es de las tres lecturas y el
 * docblock del controller lo dice—. Este spec fija lo único que sí es de esta tarea:
 * que el handler pase el body validado tal cual, sin completar ni reinterpretar nada.
 */
describe('SubscriptionController — alta paga', () => {
  let controller: SubscriptionController
  let service: Record<string, jest.Mock>

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        {
          provide: SubscriptionService,
          useValue: { startPaid: jest.fn().mockResolvedValue({ data: {}, acceptanceUrl: 'https://pay/x' }) },
        },
        { provide: EnterprisePricingService, useValue: {} },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<SubscriptionController>(SubscriptionController)
    service = module.get(SubscriptionService)
  })

  it('delega el body validado al servicio y devuelve el link en el TOPE', async () => {
    // Mutación: que el handler arme el objeto a mano (por ejemplo agregando un
    // `provider` o leyendo la marca de otro lado) o que envuelva la respuesta en
    // `data` → este caso se pone rojo. El front lee `res.acceptanceUrl`.
    const body = { brandId: 'brand-1', userId: 'user-1', planSlug: 'dropi-roax' }

    const result = await controller.startPaid(body)

    expect(service.startPaid).toHaveBeenCalledWith(body)
    expect(result.acceptanceUrl).toBe('https://pay/x')
  })
})
