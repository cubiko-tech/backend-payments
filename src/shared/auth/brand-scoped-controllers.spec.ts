import { HttpStatus, Logger } from '@nestjs/common'
import { WalletController } from '../../wallet/wallet.controller'
import { BillingProfileController } from '../../billing-profile/billing-profile.controller'
import { InvoiceController } from '../../invoice/invoice.controller'
import { RefundController } from '../../refund/refund.controller'
import { PaymentController } from '../../payment/payment.controller'
import { PaymentMethodController } from '../../payment-method/payment-method.controller'

const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
const FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
const RESOURCE_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'

const userReq = {
  user: {
    id: USER_ID,
    isSuperAdmin: false,
    brand: { id: OWN_BRAND_ID },
  },
}

const superAdminReq = {
  user: {
    id: '55555555-5555-4555-8555-555555555555',
    isSuperAdmin: true,
    brand: null,
  },
}

const serverReq = {
  user: {
    id: 'server',
    isSuperAdmin: false,
    brand: null,
  },
}

describe('Brand-scoped user controllers (LOC-43)', () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  describe('WalletController', () => {
    const buildSubject = (allowed = false) => {
      const walletService = {
        findByBrand: jest
          .fn()
          .mockResolvedValue({ data: [{ id: RESOURCE_ID, brandId: OWN_BRAND_ID }] }),
        getGlobalBalance: jest.fn().mockResolvedValue({ data: { balances: { COP: 1000 } } }),
        findById: jest.fn().mockResolvedValue({
          data: {
            id: RESOURCE_ID,
            brandId: allowed ? OWN_BRAND_ID : FOREIGN_BRAND_ID,
            balance: 500,
            currency: 'COP',
          },
        }),
        create: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } }),
        getTransactions: jest.fn().mockResolvedValue({ data: [], total: 0 }),
        transfer: jest.fn().mockResolvedValue({ data: { success: true } }),
        freeze: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
        unfreeze: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
        close: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
      }
      const platformClient = {
        canViewBrandCredit: jest.fn().mockResolvedValue(allowed),
      }
      const controller = new WalletController(walletService as any, platformClient as any)
      return { controller, walletService, platformClient }
    }

    it('returns 200 when listing wallets of a brand the caller belongs to', async () => {
      const { controller, walletService, platformClient } = buildSubject(true)

      const res = await controller.findByBrand(OWN_BRAND_ID, userReq)

      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, OWN_BRAND_ID)
      expect(walletService.findByBrand).toHaveBeenCalledWith(OWN_BRAND_ID)
      expect(res).toEqual({ data: [{ id: RESOURCE_ID, brandId: OWN_BRAND_ID }] })
    })

    it('rejects reading another brand wallet list with 403 and logs user, brand, and route', async () => {
      const { controller, walletService, platformClient } = buildSubject(false)

      await expect(controller.findByBrand(FOREIGN_BRAND_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })

      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
      expect(walletService.findByBrand).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`user=${USER_ID}`))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`brandId=${FOREIGN_BRAND_ID}`))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=GET /wallet'))
    })

    it('rejects missing or non-UUID brandId with 400 and never lists all brands', async () => {
      const { controller, walletService, platformClient } = buildSubject(true)

      await expect(controller.findByBrand(undefined as any, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      await expect(controller.findByBrand('not-a-uuid', userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })

      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(walletService.findByBrand).not.toHaveBeenCalled()
    })

    it('enforces brand membership and UUID validation on global-balance', async () => {
      const { controller: deniedController, walletService: deniedService } = buildSubject(false)
      await expect(
        deniedController.getGlobalBalance(FOREIGN_BRAND_ID, userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(deniedService.getGlobalBalance).not.toHaveBeenCalled()

      await expect(
        deniedController.getGlobalBalance('invalid-uuid', userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })

      const { controller: allowedController, walletService: allowedService } = buildSubject(true)
      const res = await allowedController.getGlobalBalance(OWN_BRAND_ID, userReq)
      expect(allowedService.getGlobalBalance).toHaveBeenCalledWith(OWN_BRAND_ID)
      expect(res).toEqual({ data: { balances: { COP: 1000 } } })
    })

    it('enforces brand ownership on wallet :id routes (findById, getTransactions, getBalance, freeze, unfreeze, close, transfer)', async () => {
      const { controller, walletService } = buildSubject(false)

      await expect(controller.findById(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=GET /wallet/:id'))

      await expect(controller.getTransactions(RESOURCE_ID, {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(walletService.getTransactions).not.toHaveBeenCalled()

      await expect(controller.getBalance(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })

      await expect(
        controller.transfer(
          { fromWalletId: RESOURCE_ID, toWalletId: OWN_BRAND_ID, amount: 100 },
          userReq,
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(walletService.transfer).not.toHaveBeenCalled()

      await expect(controller.freeze(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      await expect(controller.unfreeze(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      await expect(controller.close(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
    })

    it('allows superadmin and server callers without calling canViewBrandCredit', async () => {
      const { controller, walletService, platformClient } = buildSubject(false)

      await controller.findByBrand(FOREIGN_BRAND_ID, superAdminReq)
      await controller.findByBrand(FOREIGN_BRAND_ID, serverReq)
      await controller.findById(RESOURCE_ID, superAdminReq)
      await controller.findById(RESOURCE_ID, serverReq)

      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(walletService.findByBrand).toHaveBeenCalledTimes(2)
      expect(walletService.findById).toHaveBeenCalledTimes(2)
    })
  })

  describe('BillingProfileController', () => {
    const buildSubject = (allowed = false) => {
      const billingProfileService = {
        get: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
        create: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
        update: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
        getRequirements: jest.fn().mockResolvedValue({ data: { country: 'CO' } }),
      }
      const legalDocumentService = {
        findByBrand: jest.fn().mockResolvedValue({ data: [] }),
        upsert: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
        findAll: jest.fn().mockResolvedValue({ data: [] }),
        findPending: jest.fn().mockResolvedValue({ data: [] }),
        verify: jest.fn().mockResolvedValue({ data: {} }),
        reject: jest.fn().mockResolvedValue({ data: {} }),
      }
      const platformClient = {
        canViewBrandCredit: jest.fn().mockResolvedValue(allowed),
      }
      const controller = new BillingProfileController(
        billingProfileService as any,
        legalDocumentService as any,
        platformClient as any,
      )
      return { controller, billingProfileService, legalDocumentService, platformClient }
    }

    it('verifies brand membership on get, create, update, and brand legal documents', async () => {
      const {
        controller: denied,
        billingProfileService,
        legalDocumentService,
      } = buildSubject(false)

      await expect(denied.get(FOREIGN_BRAND_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=GET /billing-profile'))

      await expect(
        denied.update(FOREIGN_BRAND_ID, { legalName: 'Test' }, userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=PATCH /billing-profile'))

      await expect(denied.create({ brandId: FOREIGN_BRAND_ID }, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })

      await expect(denied.getDocuments(FOREIGN_BRAND_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })

      await expect(
        denied.uploadDocument(
          FOREIGN_BRAND_ID,
          { country: 'CO', documentType: 'RUT', documentUrl: 'https://example.com/rut.pdf' },
          userReq,
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })

      expect(billingProfileService.get).not.toHaveBeenCalled()
      expect(billingProfileService.update).not.toHaveBeenCalled()
      expect(billingProfileService.create).not.toHaveBeenCalled()
      expect(legalDocumentService.findByBrand).not.toHaveBeenCalled()
      expect(legalDocumentService.upsert).not.toHaveBeenCalled()
    })

    it('rejects missing or invalid UUID brandId on billing-profile routes with 400', async () => {
      const { controller, billingProfileService } = buildSubject(true)

      await expect(controller.get(undefined as any, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      await expect(controller.update('invalid', {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      expect(billingProfileService.get).not.toHaveBeenCalled()
      expect(billingProfileService.update).not.toHaveBeenCalled()
    })

    it('allows own brand on get and update, and leaves requirements and admin routes unchanged', async () => {
      const { controller, billingProfileService, legalDocumentService, platformClient } =
        buildSubject(true)

      await controller.get(OWN_BRAND_ID, userReq)
      await controller.update(OWN_BRAND_ID, { legalName: 'Own Brand' }, userReq)
      await controller.getRequirements('CO')
      await controller.getAllDocuments()

      expect(billingProfileService.get).toHaveBeenCalledWith(OWN_BRAND_ID)
      expect(billingProfileService.update).toHaveBeenCalledWith(OWN_BRAND_ID, {
        legalName: 'Own Brand',
      })
      expect(billingProfileService.getRequirements).toHaveBeenCalledWith('CO')
      expect(legalDocumentService.findAll).toHaveBeenCalled()
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledTimes(2)
    })
  })

  describe('InvoiceController', () => {
    const buildSubject = (allowed = false) => {
      const invoiceService = {
        findByBrand: jest.fn().mockResolvedValue({ data: [], total: 0 }),
        findById: jest.fn().mockResolvedValue({
          data: { id: RESOURCE_ID, brandId: allowed ? OWN_BRAND_ID : FOREIGN_BRAND_ID },
        }),
        findCreditNotes: jest.fn().mockResolvedValue({ data: [] }),
      }
      const invoicePdfService = {
        generatePdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      }
      const platformClient = {
        canViewBrandCredit: jest.fn().mockResolvedValue(allowed),
      }
      const controller = new InvoiceController(
        invoiceService as any,
        invoicePdfService as any,
        platformClient as any,
      )
      return { controller, invoiceService, invoicePdfService, platformClient }
    }

    it('validates brandId UUID and checks brand membership on findByBrand and :id routes', async () => {
      const { controller, invoiceService, invoicePdfService } = buildSubject(false)

      await expect(controller.findByBrand(undefined as any, {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      await expect(controller.findByBrand(FOREIGN_BRAND_ID, {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(invoiceService.findByBrand).not.toHaveBeenCalled()

      await expect(controller.findById(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=GET /invoice/:id'))

      const mockRes = { set: jest.fn(), end: jest.fn() } as any
      await expect(controller.downloadPdf(RESOURCE_ID, mockRes, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(invoicePdfService.generatePdf).not.toHaveBeenCalled()

      await expect(controller.getCreditNotes(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(invoiceService.findCreditNotes).not.toHaveBeenCalled()
    })

    it('allows own brand on findByBrand and findById', async () => {
      const { controller, invoiceService } = buildSubject(true)

      await controller.findByBrand(OWN_BRAND_ID, { page: 1 }, userReq)
      const detail = await controller.findById(RESOURCE_ID, userReq)

      expect(invoiceService.findByBrand).toHaveBeenCalledWith(OWN_BRAND_ID, { page: 1 })
      expect(detail).toEqual({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } })
    })
  })

  describe('RefundController', () => {
    const buildSubject = (allowed = false) => {
      const refundService = {
        request: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } }),
        findByBrand: jest.fn().mockResolvedValue({ data: [], total: 0 }),
        findById: jest.fn().mockResolvedValue({
          data: { id: RESOURCE_ID, brandId: allowed ? OWN_BRAND_ID : FOREIGN_BRAND_ID },
        }),
        approve: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
      }
      const platformClient = {
        canViewBrandCredit: jest.fn().mockResolvedValue(allowed),
      }
      const controller = new RefundController(refundService as any, platformClient as any)
      return { controller, refundService, platformClient }
    }

    it('validates brandId UUID and checks brand membership on findByBrand, request, findById, and approve', async () => {
      const { controller, refundService } = buildSubject(false)

      await expect(controller.findByBrand(undefined as any, {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      await expect(controller.findByBrand(FOREIGN_BRAND_ID, {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      await expect(
        controller.request({ brandId: FOREIGN_BRAND_ID }, userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(refundService.findByBrand).not.toHaveBeenCalled()
      expect(refundService.request).not.toHaveBeenCalled()

      await expect(controller.findById(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=GET /refund/:id'))

      await expect(
        controller.approve(RESOURCE_ID, { approvedBy: USER_ID }, userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(refundService.approve).not.toHaveBeenCalled()
    })

    it('allows own brand on findByBrand and findById', async () => {
      const { controller, refundService } = buildSubject(true)

      await controller.findByBrand(OWN_BRAND_ID, {}, userReq)
      const detail = await controller.findById(RESOURCE_ID, userReq)

      expect(refundService.findByBrand).toHaveBeenCalledWith(OWN_BRAND_ID, {})
      expect(detail).toEqual({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } })
    })
  })

  describe('PaymentController', () => {
    const buildSubject = (allowed = false) => {
      const paymentService = {
        createCheckout: jest
          .fn()
          .mockResolvedValue({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } }),
        getPaymentById: jest.fn().mockResolvedValue({
          data: { id: RESOURCE_ID, brandId: allowed ? OWN_BRAND_ID : FOREIGN_BRAND_ID },
        }),
        getPaymentsByBrand: jest.fn().mockResolvedValue({ data: [], total: 0 }),
        cancelPayment: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
      }
      const platformClient = {
        canViewBrandCredit: jest.fn().mockResolvedValue(allowed),
      }
      const controller = new PaymentController(paymentService as any, platformClient as any)
      return { controller, paymentService, platformClient }
    }

    it('validates brandId UUID and checks brand membership on getPaymentsByBrand, createCheckout, getPaymentById, and cancelPayment', async () => {
      const { controller, paymentService } = buildSubject(false)

      await expect(controller.getPaymentsByBrand('not-a-uuid', {}, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      await expect(
        controller.getPaymentsByBrand(FOREIGN_BRAND_ID, {}, userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      await expect(
        controller.createCheckout({ brandId: FOREIGN_BRAND_ID, amount: 100 }, userReq),
      ).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(paymentService.getPaymentsByBrand).not.toHaveBeenCalled()
      expect(paymentService.createCheckout).not.toHaveBeenCalled()

      await expect(controller.getPaymentById(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('route=GET /payment/:id'))

      await expect(controller.cancelPayment(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(paymentService.cancelPayment).not.toHaveBeenCalled()
    })

    it('allows own brand on getPaymentsByBrand and getPaymentById', async () => {
      const { controller, paymentService } = buildSubject(true)

      await controller.getPaymentsByBrand(OWN_BRAND_ID, {}, userReq)
      const detail = await controller.getPaymentById(RESOURCE_ID, userReq)

      expect(paymentService.getPaymentsByBrand).toHaveBeenCalledWith(OWN_BRAND_ID, {})
      expect(detail).toEqual({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } })
    })
  })

  describe('PaymentMethodController', () => {
    const buildSubject = (allowed = false) => {
      const paymentMethodService = {
        findByBrand: jest.fn().mockResolvedValue({ data: [] }),
        findById: jest.fn().mockResolvedValue({
          data: { id: RESOURCE_ID, brandId: allowed ? OWN_BRAND_ID : FOREIGN_BRAND_ID },
        }),
        create: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID, brandId: OWN_BRAND_ID } }),
        remove: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
        setDefault: jest.fn().mockResolvedValue({ data: { id: RESOURCE_ID } }),
      }
      const platformClient = {
        canViewBrandCredit: jest.fn().mockResolvedValue(allowed),
      }
      const controller = new PaymentMethodController(
        paymentMethodService as any,
        platformClient as any,
      )
      return { controller, paymentMethodService, platformClient }
    }

    it('validates brandId UUID and checks brand membership on findByBrand, create, remove, and setDefault', async () => {
      const { controller, paymentMethodService } = buildSubject(false)

      await expect(controller.findByBrand(undefined as any, userReq)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      })
      await expect(controller.findByBrand(FOREIGN_BRAND_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      await expect(controller.create({ brandId: FOREIGN_BRAND_ID }, userReq)).rejects.toMatchObject(
        {
          status: HttpStatus.FORBIDDEN,
        },
      )
      expect(paymentMethodService.findByBrand).not.toHaveBeenCalled()
      expect(paymentMethodService.create).not.toHaveBeenCalled()

      await expect(controller.remove(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('route=DELETE /payment-method/:id'),
      )
      expect(paymentMethodService.remove).not.toHaveBeenCalled()

      await expect(controller.setDefault(RESOURCE_ID, userReq)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('route=PATCH /payment-method/:id/default'),
      )
      expect(paymentMethodService.setDefault).not.toHaveBeenCalled()
    })

    it('allows own brand on findByBrand, create, remove, and setDefault', async () => {
      const { controller, paymentMethodService } = buildSubject(true)

      await controller.findByBrand(OWN_BRAND_ID, userReq)
      await controller.create({ brandId: OWN_BRAND_ID }, userReq)
      await controller.remove(RESOURCE_ID, userReq)
      await controller.setDefault(RESOURCE_ID, userReq)

      expect(paymentMethodService.findByBrand).toHaveBeenCalledWith(OWN_BRAND_ID)
      expect(paymentMethodService.create).toHaveBeenCalledWith({ brandId: OWN_BRAND_ID })
      expect(paymentMethodService.remove).toHaveBeenCalledWith(RESOURCE_ID)
      expect(paymentMethodService.setDefault).toHaveBeenCalledWith(RESOURCE_ID)
    })
  })
})
