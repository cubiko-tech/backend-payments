import { INestApplication } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { createServer, Server, ServerResponse } from 'http'
import { AddressInfo, Socket } from 'net'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { ClientPlatformService } from '../../src/client/client-platform.service'
import { ClientRolesService } from '../../src/client/client-roles.service'
import { ApiAuthGuard } from '../../src/shared/auth/api-auth.guard'
import { ServiceCredentialService } from '../../src/shared/auth/service-credential.service'
import { createGlobalValidationPipe } from '../../src/shared/validation/global-validation-pipe'
import { Transaction } from '../../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../../src/wallet/entities/wallet.entity'
import { TokenDebitController } from '../../src/wallet/token-debit.controller'
import { TokenWalletService } from '../../src/wallet/token-wallet.service'
import { ADS_KEY, JWT_SECRET } from './dropi-recharge.fixture'

export const DEBIT_MEMBER_ID = 'member-loc187'
// Made per run, like ADS_KEY: the valid key of a service that is not ROAX Ads.
export const OTHER_SERVICE_KEY = `psk.other-service.${randomUUID()}`

/**
 * A local stand-in for backend-platform or backend-auth: it answers with `reply`, or with `hang`
 * accepts the connection and never answers, which is what a stuck service does.
 */
export interface Upstream {
  url: string
  mode: 'ok' | 'hang'
  reply: (path: string, res: ServerResponse) => void
  hits: string[]
  close: () => Promise<void>
}

export async function startUpstream(reply: Upstream['reply']): Promise<Upstream> {
  const sockets = new Set<Socket>()
  const upstream = { mode: 'ok', reply, hits: [] as string[] } as Upstream
  const server: Server = createServer((req, res) => {
    upstream.hits.push(req.url ?? '')
    if (upstream.mode === 'ok') upstream.reply(req.url ?? '', res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  upstream.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  upstream.close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return upstream
}

/** Platform's `GET /v1/brand/rol/user`: `DEBIT_MEMBER_ID` is an admin of `brandIds` only. */
export function platformMembers(brandIds: string[]): Upstream['reply'] {
  return (path, res) => {
    const member = brandIds.some((brandId) => path.includes(encodeURIComponent(brandId)))
    const rows = member ? [{ user: DEBIT_MEMBER_ID, rol: 'admin' }] : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: rows }))
  }
}

export interface DebitApp {
  app: INestApplication
  jwt: JwtService
  tokens: TokenWalletService
}

/**
 * The debit routes behind the real guard, token wallet and platform client, on `dataSource`; the
 * platform and auth URLs come from `SERVICE_PLATFORM` and `SERVICE_AUTH`, set before this runs.
 */
export async function startDebitApp(dataSource: DataSource): Promise<DebitApp> {
  const jwt = new JwtService({ secret: JWT_SECRET })
  // R17: the LOC-173 suite clears service_credentials while it runs; its e2e proves the key itself.
  const credentials = {
    authenticate: jest.fn(async (key: string) =>
      key === ADS_KEY ? 'roax-ads' : key === OTHER_SERVICE_KEY ? 'other-service' : null,
    ),
  }
  const moduleRef = await Test.createTestingModule({
    controllers: [TokenDebitController],
    providers: [
      TokenWalletService,
      ClientPlatformService,
      Reflector,
      ApiAuthGuard,
      { provide: JwtService, useValue: jwt },
      { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
      {
        provide: getRepositoryToken(Wallet, 'DBWrite'),
        useValue: dataSource.getRepository(Wallet),
      },
      { provide: ServiceCredentialService, useValue: credentials },
      // R17: the debit routes use the service mark, never a roles permission.
      { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
    ],
  }).compile()
  const app = moduleRef.createNestApplication()
  app.useGlobalPipes(createGlobalValidationPipe())
  await app.init()
  return { app, jwt, tokens: moduleRef.get(TokenWalletService) }
}

/** `POST /token-wallet/debits` with `key` (ROAX Ads by default) and, unless null, a user token. */
export function postDebit(debits: DebitApp, body: object, userToken: string | null, key = ADS_KEY) {
  const call = request(debits.app.getHttpServer())
    .post('/token-wallet/debits')
    .set('Authorization', `Bearer ${key}`)
  if (userToken !== null) call.set('X-User-Authorization', `Bearer ${userToken}`)
  return call.send(body)
}

/** `POST /token-wallet/debits/refunds` with `key`, ROAX Ads by default, and no user token. */
export function postRefund(debits: DebitApp, body: object, key = ADS_KEY) {
  return request(debits.app.getHttpServer())
    .post('/token-wallet/debits/refunds')
    .set('Authorization', `Bearer ${key}`)
    .send(body)
}

export interface Buckets {
  gift: number
  purchased: number
  dropi: number
}

/** A brand token wallet holding `buckets`, its balance their sum. */
export function seedTokenWallet(
  dataSource: DataSource,
  brandId: string,
  buckets: Buckets,
  status = WalletStatus.ACTIVE,
) {
  const repo = dataSource.getRepository(Wallet)
  return repo.save(
    repo.create({
      brandId,
      userId: DEBIT_MEMBER_ID,
      provider: 'internal',
      currency: 'TKN',
      status,
      balance: buckets.gift + buckets.purchased + buckets.dropi,
      giftTokens: buckets.gift,
      purchasedTokens: buckets.purchased,
      dropiTokens: buckets.dropi,
    }),
  )
}

/** The wallet's balance and buckets as numbers. */
export async function walletState(dataSource: DataSource, walletId: string) {
  const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({ id: walletId })
  return {
    balance: Number(wallet.balance),
    gift: Number(wallet.giftTokens),
    purchased: Number(wallet.purchasedTokens),
    dropi: Number(wallet.dropiTokens),
  }
}

/**
 * Holds the wallet row with `FOR UPDATE` in its own transaction until the returned call, which
 * lets it go once however many times it is called.
 */
export async function holdWalletRow(dataSource: DataSource, walletId: string) {
  const queryRunner = dataSource.createQueryRunner()
  await queryRunner.connect()
  await queryRunner.startTransaction()
  await queryRunner.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId])
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      await queryRunner.rollbackTransaction()
    } finally {
      await queryRunner.release()
    }
  }
}

interface PoolView {
  options: { max: number }
  totalCount: number
  idleCount: number
}

const poolOf = (dataSource: DataSource) =>
  (dataSource.driver as unknown as { master: PoolView }).master

/** Connections of `dataSource`'s pool that are checked out right now. */
export function checkedOut(dataSource: DataSource): number {
  const pool = poolOf(dataSource)
  return pool.totalCount - pool.idleCount
}

/**
 * Checks out every free connection of `dataSource`'s pool, so the next one waits, until the returned
 * call gives them back; it gives them back once however many times it is called.
 */
export async function holdPool(dataSource: DataSource) {
  const free = poolOf(dataSource).options.max - checkedOut(dataSource)
  const held = await Promise.all(
    Array.from({ length: free }, async () => {
      const queryRunner = dataSource.createQueryRunner()
      await queryRunner.connect()
      return queryRunner
    }),
  )
  let released = false
  return async () => {
    if (released) return
    released = true
    await Promise.all(held.map((queryRunner) => queryRunner.release()))
  }
}

export function movementsOf(dataSource: DataSource, walletId: string) {
  return dataSource
    .getRepository(Transaction)
    .find({ where: { walletId }, order: { createdAt: 'ASC' } })
}
