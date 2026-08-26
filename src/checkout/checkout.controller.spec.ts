import { Test, TestingModule } from '@nestjs/testing'

import { CheckoutController } from './checkout.controller'
import { CheckoutService } from './checkout.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'

describe('CheckoutController', () => {
  let controller: CheckoutController
  let checkoutService: { processCheckout: jest.Mock }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        {
          provide: CheckoutService,
          useValue: { processCheckout: jest.fn().mockResolvedValue({ paymentId: 'p-1', status: 'completed' }) },
        },
        { provide: ProviderConfigService, useValue: { getAvailableProviders: jest.fn() } },
      ],
    })
      // El controller está detrás de `ApiAuthGuard`, que inyecta `JwtService` y
      // `ClientRolesService`. Este spec prueba la LÓGICA del controller, no la
      // autenticación —eso vive en `shared/auth/api-auth.guard.spec.ts`—, así que
      // el guard se reemplaza por uno que deja pasar. Sin esto Nest falla al
      // resolver `JwtService` en el módulo de test, que es el mismo error que
      // aparecería en runtime si un módulo con endpoints autenticados no tuviera
      // `AuthModule` a mano.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<CheckoutController>(CheckoutController)
    checkoutService = module.get(CheckoutService)
  })

  it('no deja que un llamador HTTP pida el camino de precios de renovación', async () => {
    await controller.processCheckout({
      brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
      userId: 'u-1',
      purpose: 'plan_purchase',
      provider: 'wallet',
      planSlug: 'dropi-roax',
      renewal: true,
    })

    // `brandId`/`planSlug` van en la aserción a propósito: sin ellos el test también
    // pasaría si el controller descartara el resto del body en vez de sólo `renewal`.
    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        renewal: undefined,
        brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
        planSlug: 'dropi-roax',
      }),
    )
  })
})
