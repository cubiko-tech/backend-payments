import { INestApplication } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AuditService } from '../../src/audit/audit.service'
import { AuditLog } from '../../src/audit/entities/auditLog.entity'
import { BillingProfile } from '../../src/billing-profile/entities/billingProfile.entity'
import { ClientPlatformService } from '../../src/client/client-platform.service'
import { ClientRolesService } from '../../src/client/client-roles.service'
import { Payment } from '../../src/payment/entities/payment.entity'
import { DropiRechargeResultController } from '../../src/recharge/dropi-recharge-result.controller'
import { DropiRechargeResultService } from '../../src/recharge/dropi-recharge-result.service'
import { DropiRechargeSignal } from '../../src/recharge/dropi-recharge-signal'
import { DropiRechargeController } from '../../src/recharge/dropi-recharge.controller'
import { DropiRechargeService } from '../../src/recharge/dropi-recharge.service'
import { APM_AGENT, ApmAgent, ApmAttributes } from '../../src/shared/apm/apm-agent'
import { ApiAuthGuard } from '../../src/shared/auth/api-auth.guard'
import { ServiceCredentialService } from '../../src/shared/auth/service-credential.service'
import { createGlobalValidationPipe } from '../../src/shared/validation/global-validation-pipe'
import { TaxService } from '../../src/tax/tax.service'
import { Transaction } from '../../src/transaction/entities/transaction.entity'
import { TRM_SOURCE_URL, TrmService } from '../../src/trm/trm.service'
import { Wallet } from '../../src/wallet/entities/wallet.entity'
import { TokenWalletService } from '../../src/wallet/token-wallet.service'
import { TrmSource } from './trm-source.fixture'

export const MEMBER_ID = 'member-loc174'
// Made per run: the credential double accepts exactly this value, so no key sits in the source.
export const ADS_KEY = `psk.roax-ads.${randomUUID()}`
export const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc174-jwt-secret', 'e2e-loc174-server-token']
export const COLOMBIAN_VAT = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }

export interface RechargeApp {
  app: INestApplication
  moduleRef: TestingModule
  jwt: JwtService
  tax: { getTaxForCountry: jest.Mock }
  platform: { canViewBrandCredit: jest.Mock }
  apm: ApmDouble
}

/** What the New Relic double was handed, in order. */
export interface ApmDouble extends ApmAgent {
  events: { type: string; attributes: ApmAttributes }[]
}

// R17: New Relic is an external service with a cost; the double keeps what the agent would send.
export function apmDouble(): ApmDouble {
  const events: ApmDouble['events'] = []
  return { events, recordCustomEvent: (type, attributes) => events.push({ type, attributes }) }
}

/**
 * The recharge route behind the real guard, service, TRM client and token wallet, on `dataSource`.
 * Doubles only what is remote or shared by every suite, each with its reason below. `MEMBER_ID`
 * is a member of `brandId` only; each suite passes its own brand, since suites run at once.
 */
export async function startRechargeApp(dataSource: DataSource, trm: TrmSource, brandId: string) {
  const jwt = new JwtService({ secret: JWT_SECRET })
  // R17: tax_config is reference data shared by every suite; the case fixes the 19 % it prices with.
  const tax = { getTaxForCountry: jest.fn().mockResolvedValue(COLOMBIAN_VAT) }
  // R17: membership lives in backend-platform, a remote service; only the member belongs here.
  const platform = {
    canViewBrandCredit: jest.fn(
      async (userId: string, brand: string) => userId === MEMBER_ID && brand === brandId,
    ),
  }
  // R17: the LOC-173 suite clears service_credentials while it runs; its e2e proves the key itself.
  const credentials = {
    authenticate: jest.fn(async (key: string) => (key === ADS_KEY ? 'roax-ads' : null)),
  }
  const apm = apmDouble()
  const repo = (entity: unknown, connection: string) => ({
    provide: getRepositoryToken(entity as never, connection),
    useValue: dataSource.getRepository(entity as never),
  })
  const moduleRef = await Test.createTestingModule({
    controllers: [DropiRechargeController, DropiRechargeResultController],
    providers: [
      DropiRechargeService,
      DropiRechargeResultService,
      DropiRechargeSignal,
      { provide: APM_AGENT, useValue: apm },
      AuditService,
      repo(AuditLog, 'DBWrite'),
      repo(AuditLog, 'DBRead'),
      TokenWalletService,
      TrmService,
      Reflector,
      ApiAuthGuard,
      { provide: TRM_SOURCE_URL, useValue: trm.url },
      { provide: JwtService, useValue: jwt },
      { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
      repo(Payment, 'DBWrite'),
      repo(Wallet, 'DBWrite'),
      repo(BillingProfile, 'DBRead'),
      { provide: TaxService, useValue: tax },
      { provide: ClientPlatformService, useValue: platform },
      { provide: ServiceCredentialService, useValue: credentials },
      // R17: the recharge route uses the service mark, never a roles permission.
      { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
    ],
  }).compile()
  const app = moduleRef.createNestApplication()
  app.useGlobalPipes(createGlobalValidationPipe())
  await app.init()
  return { app, moduleRef, jwt, tax, platform, apm } as RechargeApp
}

/** Drops the TRM cached by an earlier case: the cache lasts an hour and each case sets its rate. */
export function forgetCachedTrm(recharge: RechargeApp): void {
  Object.assign(recharge.moduleRef.get(TrmService), { cached: undefined })
}

/** `POST /recharge/dropi` with the ROAX Ads key and, unless `userToken` is null, a person's token. */
export function postRecharge(recharge: RechargeApp, body: object, userToken: string | null) {
  const call = request(recharge.app.getHttpServer())
    .post('/recharge/dropi')
    .set('Authorization', `Bearer ${ADS_KEY}`)
  if (userToken !== null) call.set('X-User-Authorization', `Bearer ${userToken}`)
  return call.send(body)
}

/** `POST /recharge/dropi/:id/result` with the ROAX Ads key only, as the result arrives. */
export function postResult(recharge: RechargeApp, id: string, body: object) {
  return request(recharge.app.getHttpServer())
    .post(`/recharge/dropi/${id}/result`)
    .set('Authorization', `Bearer ${ADS_KEY}`)
    .send(body)
}

export function rechargesOf(dataSource: DataSource, brandId: string) {
  return dataSource.getRepository(Payment).find({ where: { brandId } })
}

export function tokenWalletOf(dataSource: DataSource, brandId: string) {
  return dataSource.getRepository(Wallet).findOneByOrFail({ brandId, currency: 'TKN' })
}

export function creditsOf(dataSource: DataSource, paymentId: string) {
  return dataSource.getRepository(Transaction).findBy({ referenceId: paymentId })
}

export function auditOf(dataSource: DataSource, paymentId: string) {
  return dataSource.getRepository(AuditLog).findBy({ entityType: 'payment', entityId: paymentId })
}

export async function cleanBillingProfile(dataSource: DataSource, brandId: string) {
  await dataSource.query('DELETE FROM billing_profiles WHERE "brandId" = $1', [brandId])
}
