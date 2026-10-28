import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants'
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum'
import { WalletController } from '../../wallet/wallet.controller'
import { WalletService } from '../../wallet/wallet.service'
import { WalletProvider, WalletStatus } from '../../wallet/entities/wallet.entity'
import { PaymentController } from '../../payment/payment.controller'
import { PaymentService } from '../../payment/payment.service'
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../../payment/entities/payment.entity'
import { RefundController } from '../../refund/refund.controller'
import { RefundService } from '../../refund/refund.service'
import { RefundReason, RefundStatus } from '../../refund/entities/refund.entity'
import { PaymentMethodController } from '../../payment-method/payment-method.controller'
import { PaymentMethodService } from '../../payment-method/payment-method.service'
import {
  PaymentMethodStatus,
  PaymentMethodType,
} from '../../payment-method/entities/paymentMethod.entity'
import { BillingProfileController } from '../../billing-profile/billing-profile.controller'
import { BillingProfileService } from '../../billing-profile/billing-profile.service'
import { TaxIdType, TaxRegime } from '../../billing-profile/entities/billingProfile.entity'

const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
const FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
const VALID_UUID = '33333333-3333-4333-8333-333333333333'

function getBodyMetatype(controllerClass: { prototype: object }, methodName: string): any {
  const paramTypes: any[] =
    Reflect.getMetadata('design:paramtypes', controllerClass.prototype, methodName) || []
  const routeArgs: Record<string, { index: number }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controllerClass, methodName) || {}

  const bodyEntry = Object.entries(routeArgs).find(([key]) =>
    key.startsWith(`${RouteParamtypes.BODY}:`),
  )
  const bodyIndex = bodyEntry ? bodyEntry[1].index : 0
  return paramTypes[bodyIndex]
}

describe('Body DTO whitelist and repository sanitization (LOC-44)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  })

  describe('POST /wallet (WalletController.create & WalletService.create)', () => {
    const validWalletBody = {
      provider: WalletProvider.INTERNAL,
      currency: 'USD',
      label: 'Primary wallet',
    }

    it('rejects invented balance in POST /wallet with 400 and creates no wallet', async () => {
      const metatype = getBodyMetatype(WalletController, 'create')
      const walletRepo = {
        create: jest.fn((d) => d),
        save: jest.fn((d) => Promise.resolve({ id: 'w-1', ...d })),
      }
      const walletReadRepo = { count: jest.fn().mockResolvedValue(0) }
      const walletService = new WalletService(
        walletRepo as any,
        walletReadRepo as any,
        {} as any,
        {} as any,
        {} as any,
      )
      const platformClient = { canViewBrandCredit: jest.fn().mockResolvedValue(true) }
      const controller = new WalletController(walletService, platformClient as any)

      const runPipeAndCreate = async (rawBody: Record<string, unknown>) => {
        const dto = await pipe.transform(rawBody, { type: 'body', metatype })
        return controller.create(dto, {
          user: { id: 'user-1', brand: OWN_BRAND_ID },
        })
      }

      await expect(
        runPipeAndCreate({ ...validWalletBody, balance: 1000000 }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(walletRepo.create).not.toHaveBeenCalled()
      expect(walletRepo.save).not.toHaveBeenCalled()
    })

    it.each(['balance', 'id', 'status', 'brandId', 'frozenBalance'])(
      'rejects prohibited field "%s" in POST /wallet body with 400',
      async (prohibitedField) => {
        const metatype = getBodyMetatype(WalletController, 'create')

        await expect(
          pipe.transform(
            { ...validWalletBody, [prohibitedField]: 'forbidden-value' },
            { type: 'body', metatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException)
      },
    )

    it('creates a clean wallet with balance 0 when only allowed fields are sent', async () => {
      const metatype = getBodyMetatype(WalletController, 'create')
      const walletRepo = {
        create: jest.fn((d) => d),
        save: jest.fn((d) => Promise.resolve({ id: 'w-clean', ...d })),
      }
      const walletReadRepo = { count: jest.fn().mockResolvedValue(0) }
      const walletService = new WalletService(
        walletRepo as any,
        walletReadRepo as any,
        {} as any,
        {} as any,
        {} as any,
      )
      const platformClient = { canViewBrandCredit: jest.fn().mockResolvedValue(true) }
      const controller = new WalletController(walletService, platformClient as any)

      const dto = await pipe.transform({ ...validWalletBody }, { type: 'body', metatype })
      const result = await controller.create(dto, {
        user: { id: 'user-1', brand: OWN_BRAND_ID },
      })

      expect(result.data).toMatchObject({
        id: 'w-clean',
        brandId: OWN_BRAND_ID,
        provider: WalletProvider.INTERNAL,
        currency: 'USD',
        balance: 0,
        status: WalletStatus.ACTIVE,
      })
    })
  })

  describe('PATCH & POST /billing-profile (BillingProfileController & BillingProfileService)', () => {
    const validCreateProfileBody = {
      legalName: 'Acme SAS',
      taxId: '900123456-7',
      taxIdType: TaxIdType.NIT,
      country: 'CO',
      email: 'billing@acme.co',
      taxRegime: TaxRegime.RESPONSABLE_IVA,
    }

    it('rejects foreign brandId in PATCH /billing-profile body with 400 and keeps profile on its own brand', async () => {
      const metatype = getBodyMetatype(BillingProfileController, 'update')
      const existingProfile = {
        id: 'bp-1',
        brandId: OWN_BRAND_ID,
        legalName: 'Acme SAS',
        taxId: '900123456-7',
        taxIdType: TaxIdType.NIT,
        country: 'CO',
        email: 'billing@acme.co',
      }
      const billingProfileRepo = {
        findOne: jest.fn().mockResolvedValue(existingProfile),
        save: jest.fn((p) => Promise.resolve(p)),
      }
      const countryConfig = { validateBillingProfile: jest.fn().mockResolvedValue([]) }
      const service = new BillingProfileService(
        billingProfileRepo as any,
        billingProfileRepo as any,
        countryConfig as any,
      )
      const platformClient = { canViewBrandCredit: jest.fn().mockResolvedValue(true) }
      const controller = new BillingProfileController(service, {} as any, platformClient as any)

      const runPipeAndUpdate = async (rawBody: Record<string, unknown>) => {
        const dto = await pipe.transform(rawBody, { type: 'body', metatype })
        return controller.update(OWN_BRAND_ID, dto, {
          user: { id: 'user-1', brand: OWN_BRAND_ID },
        })
      }

      await expect(
        runPipeAndUpdate({ legalName: 'Hijacked', brandId: FOREIGN_BRAND_ID }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(billingProfileRepo.save).not.toHaveBeenCalled()
      expect(existingProfile.brandId).toBe(OWN_BRAND_ID)

      await service.update(OWN_BRAND_ID, {
        legalName: 'Updated Name',
        brandId: FOREIGN_BRAND_ID,
        id: 'injected-id',
      } as any)
      expect(existingProfile.brandId).toBe(OWN_BRAND_ID)
      expect(existingProfile.id).toBe('bp-1')
      expect(existingProfile.legalName).toBe('Updated Name')
    })

    it.each(['brandId', 'id', 'status', 'balance'])(
      'rejects prohibited field "%s" in POST and PATCH /billing-profile',
      async (prohibitedField) => {
        const createMetatype = getBodyMetatype(BillingProfileController, 'create')
        const updateMetatype = getBodyMetatype(BillingProfileController, 'update')

        await expect(
          pipe.transform(
            { ...validCreateProfileBody, [prohibitedField]: 'forbidden' },
            { type: 'body', metatype: createMetatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException)

        await expect(
          pipe.transform(
            { legalName: 'Valid Name', [prohibitedField]: 'forbidden' },
            { type: 'body', metatype: updateMetatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException)
      },
    )
  })

  describe('POST /payment/checkout, POST /refund, POST /payment-method', () => {
    const validCheckoutBody = {
      provider: PaymentProvider.STRIPE,
      amount: 50,
      currency: 'USD',
      purpose: PaymentPurpose.WALLET_RECHARGE,
    }

    const validRefundBody = {
      paymentId: VALID_UUID,
      amount: 25,
      currency: 'USD',
      reason: RefundReason.CUSTOMER_REQUEST,
    }

    const validPaymentMethodBody = {
      provider: 'stripe',
      providerMethodId: 'pm_12345',
      type: PaymentMethodType.CARD,
      last4: '4242',
    }

    it.each(['status', 'id', 'brandId', 'balance'])(
      'rejects prohibited field "%s" in POST /payment/checkout with 400',
      async (prohibitedField) => {
        const metatype = getBodyMetatype(PaymentController, 'createCheckout')

        await expect(
          pipe.transform(
            { ...validCheckoutBody, [prohibitedField]: 'forbidden' },
            { type: 'body', metatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException)
      },
    )

    it.each(['status', 'id', 'brandId', 'balance'])(
      'rejects prohibited field "%s" in POST /refund with 400',
      async (prohibitedField) => {
        const metatype = getBodyMetatype(RefundController, 'request')

        await expect(
          pipe.transform(
            { ...validRefundBody, [prohibitedField]: 'forbidden' },
            { type: 'body', metatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException)
      },
    )

    it.each(['status', 'id', 'brandId', 'balance'])(
      'rejects prohibited field "%s" in POST /payment-method with 400',
      async (prohibitedField) => {
        const metatype = getBodyMetatype(PaymentMethodController, 'create')

        await expect(
          pipe.transform(
            { ...validPaymentMethodBody, [prohibitedField]: 'forbidden' },
            { type: 'body', metatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException)
      },
    )

    it('sanitizes fields passed to repositories in PaymentService, RefundService, and PaymentMethodService', async () => {
      const paymentRepo = {
        create: jest.fn((d) => d),
        save: jest.fn((d) => Promise.resolve({ id: 'pay-1', ...d })),
      }
      const paymentService = new PaymentService(
        paymentRepo as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      )
      await paymentService.createCheckout({
        ...validCheckoutBody,
        brandId: OWN_BRAND_ID,
        id: 'injected-pay-id',
        status: PaymentStatus.COMPLETED,
      } as any)
      expect(paymentRepo.create.mock.calls[0][0]).not.toHaveProperty('id')
      expect(paymentRepo.create.mock.calls[0][0].status).toBe(PaymentStatus.PENDING)

      const refundRepo = {
        create: jest.fn((d) => d),
        save: jest.fn((d) => Promise.resolve({ id: 'ref-1', ...d })),
      }
      const refundService = new RefundService(refundRepo as any, {} as any)
      await refundService.request({
        ...validRefundBody,
        brandId: OWN_BRAND_ID,
        id: 'injected-ref-id',
        status: RefundStatus.COMPLETED,
      } as any)
      expect(refundRepo.create.mock.calls[0][0]).not.toHaveProperty('id')
      expect(refundRepo.create.mock.calls[0][0].status).toBe(RefundStatus.PENDING)

      const paymentMethodRepo = {
        create: jest.fn((d) => d),
        save: jest.fn((d) => Promise.resolve({ id: 'pm-1', ...d })),
      }
      const paymentMethodService = new PaymentMethodService(
        paymentMethodRepo as any,
        {} as any,
        {} as any,
      )
      await paymentMethodService.create({
        ...validPaymentMethodBody,
        brandId: OWN_BRAND_ID,
        id: 'injected-pm-id',
        status: PaymentMethodStatus.EXPIRED,
      } as any)
      expect(paymentMethodRepo.create.mock.calls[0][0]).not.toHaveProperty('id')
      expect(paymentMethodRepo.create.mock.calls[0][0].status).toBe(PaymentMethodStatus.ACTIVE)
    })
  })
})
