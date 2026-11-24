/**
 * The error paths of the /admin routes answer their HTTP status and the error contract
 * `{ statusCode, code, message }`, over HTTP with the global filter and real PostgreSQL tables:
 * the duplicate cases need the unique indexes of `wallets` and `provider_config`.
 */
import { INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { randomUUID } from 'crypto'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource, Repository } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { CreditService } from '../src/credit/credit.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { ProviderConfig } from '../src/provider/entities/providerConfig.entity'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { HttpErrorFilter } from '../src/shared/exception/http-error.filter'
import { logger } from '../src/shared/logger/logger'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { WalletService } from '../src/wallet/wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'

dotenvConfig({ path: '.env' })

const BRAND_ID = 'a3480001-0000-4000-8000-000000000001'
const COUNTRY = 'ZQ'
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc348-jwt-secret', 'e2e-loc348-server-token']

describe('Admin routes answer their error status and code (PostgreSQL, LOC-348)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let wallets: Repository<Wallet>
  let providers: Repository<ProviderConfig>
  let payments: Repository<Payment>
  let superAdmin = ''
  // R17: the brand token wallet has its own e2e (wallet-on-brand-birth); here only its call is read.
  const tokenWallets = { getOrCreate: jest.fn().mockResolvedValue({}) }

  const http = () => request(app.getHttpServer())
  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${superAdmin}`)
  const walletBody = { brandId: BRAND_ID, provider: 'internal', currency: 'COP' }
  const providerBody = { country: COUNTRY, provider: 'loc348' }

  const seedWallet = (status = WalletStatus.ACTIVE) =>
    wallets.save(
      wallets.create({ ...walletBody, userId: BRAND_ID, balance: 0, status, label: 'loc348' }),
    )
  const seedProvider = () =>
    providers.save(providers.create({ country: COUNTRY, provider: 'loc348', isActive: true }))

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query('DELETE FROM payments WHERE "brandId" = $1', [BRAND_ID])
    await dataSource.query('DELETE FROM wallets WHERE "brandId" = $1', [BRAND_ID])
    await dataSource.query('DELETE FROM provider_config WHERE country = $1', [COUNTRY])
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Payment, Subscription, Wallet, ProviderConfig],
      synchronize: false,
    })
    await dataSource.initialize()
    wallets = dataSource.getRepository(Wallet)
    providers = dataSource.getRepository(ProviderConfig)
    payments = dataSource.getRepository(Payment)

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdmin = jwtService.sign({ id: 'superadmin-loc348', isSuperAdmin: true, brand: null })
    const entities = [Subscription, Payment, Wallet, ProviderConfig]
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        ...entities.flatMap((entity) =>
          ['DBRead', 'DBWrite'].map((conn) => ({
            provide: getRepositoryToken(entity, conn),
            useValue: dataSource.getRepository(entity),
          })),
        ),
        // R17: constructor dependencies none of these error paths reach.
        { provide: getRepositoryToken(WalletBalanceSnapshot, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CreditService, useValue: {} },
        { provide: WalletService, useValue: {} },
        { provide: TokenWalletService, useValue: tokenWallets },
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    app.useGlobalFilters(new HttpErrorFilter())
    await app.init()
  })

  beforeEach(async () => {
    tokenWallets.getOrCreate.mockClear()
    await clean()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('answers POST /admin/subscriptions/:id/extend of a missing subscription with 404', async () => {
    // R15: red when extendSubscription returns `{ error }` again: the case receives 201.
    const res = await asAdmin(http().post(`/admin/subscriptions/${randomUUID()}/extend`)).send({
      days: 5,
    })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'SUBSCRIPTION_NOT_FOUND',
      message: 'Suscripción no encontrada',
    })
  })

  it('answers POST /admin/payments/:id/retry of a missing payment with 404', async () => {
    // R15: red when retryPayment returns `{ error }` for a missing payment again: the case receives 201.
    const res = await asAdmin(http().post(`/admin/payments/${randomUUID()}/retry`))

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'PAYMENT_NOT_FOUND',
      message: 'Pago no encontrado',
    })
  })

  it('answers POST /admin/payments/:id/retry of a completed payment with 409 and leaves it completed', async () => {
    // R15: red when retryPayment returns `{ error }` for a non-failed payment again: the case receives 201.
    const payment = await payments.save(
      payments.create({
        brandId: BRAND_ID,
        userId: 'user-loc348',
        provider: PaymentProvider.WALLET,
        amount: 1000,
        currency: 'COP',
        status: PaymentStatus.COMPLETED,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'pro',
      }),
    )

    const res = await asAdmin(http().post(`/admin/payments/${payment.id}/retry`))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      statusCode: 409,
      code: 'PAYMENT_NOT_FAILED',
      message: 'Pago no está en estado failed (actual: completed)',
    })
    expect((await payments.findOneByOrFail({ id: payment.id })).status).toBe(
      PaymentStatus.COMPLETED,
    )
  })

  it('answers POST /admin/wallets for an existing wallet with 409 and creates no other', async () => {
    // R15: red when createWallet returns `{ error }` for a duplicate again: the case receives 201.
    const existing = await seedWallet()

    const res = await asAdmin(http().post('/admin/wallets')).send(walletBody)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      statusCode: 409,
      code: 'WALLET_ALREADY_EXISTS',
      message: 'Ya existe una wallet internal/COP para esta marca',
    })
    expect((await wallets.findBy({ brandId: BRAND_ID })).map((w) => w.id)).toEqual([existing.id])
    expect(tokenWallets.getOrCreate).toHaveBeenCalledWith(BRAND_ID, BRAND_ID)
  })

  it('answers POST /admin/wallets with 409 when the duplicate lands between the read and the save', async () => {
    // R15: red without the unique-violation catch of createWallet: the 23505 reaches the filter as 500.
    let raced: Wallet | undefined
    jest.spyOn(wallets, 'findOne').mockImplementationOnce(async () => {
      raced = await seedWallet()
      return null
    })

    const res = await asAdmin(http().post('/admin/wallets')).send(walletBody)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('WALLET_ALREADY_EXISTS')
    expect((await wallets.findBy({ brandId: BRAND_ID })).map((w) => w.id)).toEqual([raced!.id])
    expect(tokenWallets.getOrCreate).toHaveBeenCalledWith(BRAND_ID, BRAND_ID)
  })

  it('answers POST /admin/wallets/:id/toggle-freeze of a missing wallet with 404', async () => {
    // R15: red when toggleFreezeWallet returns `{ error }` for a missing wallet again: the case receives 201.
    const res = await asAdmin(http().post(`/admin/wallets/${randomUUID()}/toggle-freeze`))

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'WALLET_NOT_FOUND',
      message: 'Wallet no encontrada',
    })
  })

  it('answers POST /admin/wallets/:id/toggle-freeze of a closed wallet with 409 and leaves it closed', async () => {
    // R15: red when toggleFreezeWallet returns `{ error }` for a closed wallet again: the case receives 201.
    const wallet = await seedWallet(WalletStatus.CLOSED)

    const res = await asAdmin(http().post(`/admin/wallets/${wallet.id}/toggle-freeze`))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      statusCode: 409,
      code: 'WALLET_CLOSED',
      message: 'Wallet cerrada, no se puede modificar',
    })
    expect((await wallets.findOneByOrFail({ id: wallet.id })).status).toBe(WalletStatus.CLOSED)
  })

  it('answers POST /admin/providers for an existing provider with 409 and creates no other', async () => {
    // R15: red when createProvider returns `{ error }` for a duplicate again: the case receives 201.
    const existing = await seedProvider()

    const res = await asAdmin(http().post('/admin/providers')).send(providerBody)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      statusCode: 409,
      code: 'PROVIDER_CONFIG_ALREADY_EXISTS',
      message: `El proveedor loc348 ya existe para ${COUNTRY}`,
    })
    expect((await providers.findBy({ country: COUNTRY })).map((p) => p.id)).toEqual([existing.id])
  })

  it('answers POST /admin/providers with 409 when the duplicate lands between the read and the save', async () => {
    // R15: red without the unique-violation catch of createProvider: the 23505 reaches the filter as 500.
    let raced: ProviderConfig | undefined
    jest.spyOn(providers, 'findOne').mockImplementationOnce(async () => {
      raced = await seedProvider()
      return null
    })

    const res = await asAdmin(http().post('/admin/providers')).send(providerBody)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROVIDER_CONFIG_ALREADY_EXISTS')
    expect((await providers.findBy({ country: COUNTRY })).map((p) => p.id)).toEqual([raced!.id])
  })

  it('answers PATCH /admin/providers/:id of a missing provider with 404', async () => {
    // R15: red when updateProvider returns `{ error }` again: the case receives 200.
    const res = await asAdmin(http().patch(`/admin/providers/${randomUUID()}`)).send({
      isActive: false,
    })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'PROVIDER_CONFIG_NOT_FOUND',
      message: 'Proveedor no encontrado',
    })
  })

  it('answers a QueryFailedError with 500 internalError and no SQL or parameters in the body', async () => {
    // R15: red when the filter builds the 5xx message from the original error: the SQL reaches the body.
    jest.spyOn(logger, 'error').mockImplementation(() => logger)
    const id = randomUUID()
    jest
      .spyOn(payments, 'findOne')
      .mockImplementationOnce(() =>
        dataSource.query('SELECT * FROM loc348_missing_table WHERE id = $1', [id]),
      )

    const res = await asAdmin(http().post(`/admin/payments/${id}/retry`))

    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      statusCode: 500,
      code: 'internalError',
      message: 'Internal server error',
    })
    expect(JSON.stringify(res.body)).not.toMatch(/loc348_missing_table|SELECT/)
    expect(JSON.stringify(res.body)).not.toContain(id)
  })

  it('answers an unexpected error with 500 internalError and no stack in the body', async () => {
    // R15: red when the filter puts the stack or the original message in the body.
    jest.spyOn(logger, 'error').mockImplementation(() => logger)
    jest.spyOn(wallets, 'findOne').mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'status')")
    })

    const res = await asAdmin(http().post(`/admin/wallets/${randomUUID()}/toggle-freeze`))

    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      statusCode: 500,
      code: 'internalError',
      message: 'Internal server error',
    })
    expect(JSON.stringify(res.body)).not.toMatch(/reading 'status'|at /)
  })
})
