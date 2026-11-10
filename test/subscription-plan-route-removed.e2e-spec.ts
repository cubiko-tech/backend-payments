import { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { DataSource, Repository } from 'typeorm'

import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { unknownServiceKeys } from './support/service-credential.double'
import { ConfioCancellationService } from '../src/subscription/confio-cancellation.service'
import { ConfioTrialService } from '../src/subscription/confio-trial.service'
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionController } from '../src/subscription/subscription.controller'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { ConfioSubscriptionWebhookService } from '../src/webhook/confio-subscription-webhook.service'

const ACCESS_SERVER = 'e2e-subscription-plan-removed-token'
const BRAND_ID = 'a1093939-2222-4333-8444-555555555555'
const PAID_PLAN = 'starter'

describe('PATCH /subscription/plan removal e2e (PostgreSQL, LOC-109)', () => {
  let app: INestApplication
  let dataSource: DataSource
  let subscriptions: Repository<Subscription>
  let events: Repository<SubscriptionEvent>
  const envSnapshot = {
    ACCESS_SERVER: process.env.ACCESS_SERVER,
    JWT_SECRET: process.env.JWT_SECRET,
  }

  const cleanBrand = async () => {
    await dataSource.query(
      'DELETE FROM subscription_events WHERE "subscriptionId" IN (SELECT id FROM subscriptions WHERE "brandId" = $1)',
      [BRAND_ID],
    )
    await subscriptions.delete({ brandId: BRAND_ID })
  }

  const seedSubscription = () =>
    subscriptions.save(
      subscriptions.create({
        brandId: BRAND_ID,
        userId: 'user-e2e-109',
        planSlug: PAID_PLAN,
        provider: SubscriptionProvider.WALLET,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
      }),
    )

  beforeAll(async () => {
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.JWT_SECRET = 'e2e-subscription-plan-removed-jwt'
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities: [Subscription, SubscriptionEvent],
      synchronize: false,
    })
    await dataSource.initialize()
    subscriptions = dataSource.getRepository(Subscription)
    events = dataSource.getRepository(SubscriptionEvent)

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        ApiAuthGuard,
        unknownServiceKeys,
        JwtService,
        SubscriptionService,
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subscriptions },
        { provide: getRepositoryToken(Subscription, 'DBRead'), useValue: subscriptions },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: events },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBRead'), useValue: events },
        // R17: Empty doubles: no case reaches these outbound services; only their DI slot is needed.
        { provide: EventBusService, useValue: {} },
        { provide: ConfioTrialService, useValue: {} },
        { provide: ConfioCancellationService, useValue: {} },
        { provide: ConfioSubscriptionWebhookService, useValue: {} },
        { provide: EnterprisePricingService, useValue: {} },
        { provide: ClientRolesService, useValue: {} },
        // R17: Platform is another service; the server principal never asks it for membership.
        { provide: ClientPlatformService, useValue: {} },
      ],
    }).compile()

    app = moduleFixture.createNestApplication()
    await app.init()
  })

  beforeEach(cleanBrand)

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) await cleanBrand()
    } finally {
      try {
        if (app) await app.close()
      } finally {
        if (dataSource?.isInitialized) await dataSource.destroy()
        process.env.ACCESS_SERVER = envSnapshot.ACCESS_SERVER
        process.env.JWT_SECRET = envSnapshot.JWT_SECRET
      }
    }
  })

  it('responds 404 on PATCH /subscription/plan and leaves the plan and its events untouched', async () => {
    // R15 (Mutation): restoring @Patch('plan') changePlan returns 200 and turns this red.
    const seeded = await seedSubscription()

    const res = await request(app.getHttpServer())
      .patch('/subscription/plan')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send({ brandId: BRAND_ID, planSlug: 'enterprise', triggeredBy: 'server' })

    expect(res.status).toBe(404)
    const row = await subscriptions.findOneByOrFail({ id: seeded.id })
    expect(row.planSlug).toBe(PAID_PLAN)
    expect(await events.countBy({ subscriptionId: seeded.id })).toBe(0)
  })

  it('has no changePlan left on the controller or the service', () => {
    // R15 (Mutation): restoring SubscriptionService.changePlan alone turns this red.
    expect(Reflect.get(SubscriptionController.prototype, 'changePlan')).toBeUndefined()
    expect(Reflect.get(SubscriptionService.prototype, 'changePlan')).toBeUndefined()
  })

  it('still answers GET /subscription with the same plan', async () => {
    // R15 (Mutation): removing @Get() getCurrent from the controller returns 404 and turns this red.
    await seedSubscription()

    const res = await request(app.getHttpServer())
      .get('/subscription')
      .query({ brandId: BRAND_ID })
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ brandId: BRAND_ID, planSlug: PAID_PLAN })
  })
})
