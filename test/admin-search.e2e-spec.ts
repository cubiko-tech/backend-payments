/**
 * Admin list searches (wallets, subscriptions, payments) over HTTP against PostgreSQL: the
 * search SQL is only checked by the database, so a repository double would not see a bad column.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { CreditService } from '../src/credit/credit.service'
import { Payment, PaymentProvider, PaymentPurpose } from '../src/payment/entities/payment.entity'
import { ProviderConfig } from '../src/provider/entities/providerConfig.entity'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import {
  Subscription,
  SubscriptionProvider,
} from '../src/subscription/entities/subscription.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'
import { authSessionsDouble } from './support/auth-session.double'
import { SessionVerifier } from '../src/shared/auth/session-verifier.service'

dotenvConfig({ path: '.env' })

const [BRAND_LABELED, BRAND_PLAIN, BRAND_PERCENT] = [
  'e266a001-0000-4000-8000-000000000001',
  'e266b002-0000-4000-8000-000000000002',
  'e266c003-0000-4000-8000-000000000003',
]
const BRANDS = [BRAND_LABELED, BRAND_PLAIN, BRAND_PERCENT]
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc266-jwt-secret', 'e2e-loc266-server-token']

describe('Admin list searches over HTTP (PostgreSQL, LOC-266)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let superAdmin = ''

  const list = (path: string, search: string) =>
    request(app.getHttpServer())
      .get(`/admin/${path}`)
      .query({ search, perPage: 100 })
      .set('Authorization', `Bearer ${superAdmin}`)
  const ourBrands = (body: { data: { brandId: string }[] }) =>
    body.data.map((row) => row.brandId).filter((brandId) => BRANDS.includes(brandId))

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    for (const table of ['payments', 'subscriptions', 'wallets'])
      await dataSource.query(`DELETE FROM ${table} WHERE "brandId" = ANY($1)`, [BRANDS])
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
      entities: [Payment, Subscription, Wallet],
      synchronize: false,
    })
    await dataSource.initialize()

    const sessions = authSessionsDouble()
    superAdmin = sessions.sign({ id: 'superadmin-loc266', isSuperAdmin: true, brand: null })
    const repo = (entity: any, conn: string) => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: SessionVerifier, useValue: sessions },
        ...[Subscription, Payment, Wallet].flatMap((e) => [repo(e, 'DBRead'), repo(e, 'DBWrite')]),
        // R17: the constructor needs them; the list routes never touch these tables.
        { provide: getRepositoryToken(ProviderConfig, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(ProviderConfig, 'DBWrite'), useValue: {} },
        { provide: getRepositoryToken(WalletBalanceSnapshot, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: {} },
        // R17: constructor dependencies the list routes never call.
        { provide: AuditService, useValue: {} },
        { provide: CreditService, useValue: {} },
        { provide: WalletService, useValue: {} },
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()

    await clean()
    const wallets = dataSource.getRepository(Wallet)
    const labels: [string, string][] = [
      [BRAND_LABELED, 'Prueba'],
      [BRAND_PLAIN, 'Otra'],
      [BRAND_PERCENT, '50% off'],
    ]
    for (const [brandId, label] of labels)
      await wallets.save(
        wallets.create({
          brandId,
          userId: brandId,
          provider: 'internal',
          currency: 'COP',
          status: WalletStatus.ACTIVE,
          label,
        }),
      )
    const now = new Date()
    await dataSource.getRepository(Subscription).save({
      brandId: BRAND_LABELED,
      userId: BRAND_LABELED,
      planSlug: 'loc266-plan',
      provider: SubscriptionProvider.WALLET,
      currentPeriodStart: now,
      currentPeriodEnd: now,
    })
    await dataSource.getRepository(Payment).save({
      brandId: BRAND_LABELED,
      userId: BRAND_LABELED,
      provider: PaymentProvider.WALLET,
      amount: 1000,
      currency: 'COP',
      purpose: PaymentPurpose.PLAN_PURCHASE,
    })
  })

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('finds a wallet by its label', async () => {
    // Mutation: back to `w.brandId::text`, the whole search is 500 even when the label matches.
    const res = await list('wallets', 'Prueba')

    expect(res.status).toBe(HttpStatus.OK)
    expect(ourBrands(res.body)).toEqual([BRAND_LABELED])
  })

  it('finds a wallet by the first 8 characters of its brand id', async () => {
    // Mutation: back to `w.brandId::text` in walletsList, Postgres rejects the column and this is 500.
    const res = await list('wallets', BRAND_LABELED.slice(0, 8))

    expect(res.status).toBe(HttpStatus.OK)
    expect(ourBrands(res.body)).toEqual([BRAND_LABELED])
  })

  it('treats % in the search as a literal, not a wildcard', async () => {
    // Mutation: containsPattern stops escaping, `%` matches every wallet and the other two show up.
    const res = await list('wallets', '%')

    expect(res.status).toBe(HttpStatus.OK)
    expect(ourBrands(res.body)).toEqual([BRAND_PERCENT])
  })

  it('finds the subscription and the payment by part of the brand id', async () => {
    // Mutation: back to `s.brandId::text` / `p.brandId::text`, that route answers 500.
    const prefix = BRAND_LABELED.slice(0, 8)
    const [subscriptions, payments] = [
      await list('subscriptions', prefix),
      await list('payments', prefix),
    ]

    expect([subscriptions.status, payments.status]).toEqual([HttpStatus.OK, HttpStatus.OK])
    expect([ourBrands(subscriptions.body), ourBrands(payments.body)]).toEqual([
      [BRAND_LABELED],
      [BRAND_LABELED],
    ])
  })
})
