import * as request from 'supertest'
import { INestApplication } from '@nestjs/common'
import { NestApplication, NestFactory } from '@nestjs/core'
import { bootstrap } from './main'

// R17: the real AppModule needs Postgres and Redis; one route that throws is all the bootstrap check needs.
jest.mock('./app.module', () => {
  const { Controller, HttpStatus, Module, Post } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common')
  const { RequestException } = jest.requireActual<
    typeof import('./shared/exception/request.exception')
  >('./shared/exception/request.exception')

  @Controller('probe')
  class ProbeController {
    @Post('conflict')
    conflict() {
      throw new RequestException(
        { error: 'raw', code: 'WALLET_ALREADY_EXISTS', message: 'Ya existe' },
        HttpStatus.CONFLICT,
      )
    }
  }

  @Module({ controllers: [ProbeController] })
  class AppModule {}
  return { AppModule }
})

// R17: keeps the startup line out of the log files of the working tree.
jest.mock('./shared/logger/logger', () => ({ logger: { log: jest.fn(), error: jest.fn() } }))

const realNestCreate = NestFactory.create.bind(NestFactory)

describe('bootstrap installs the global error filter', () => {
  const originalEnv = process.env
  let createdApp: INestApplication | undefined

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-cookie-signing-secret',
      ACCESS_SERVER: 'test-access-server-secret',
    }
    // listen is stubbed on the prototype for the reason main.spec.ts gives.
    jest.spyOn(NestApplication.prototype, 'listen').mockImplementation(async function (
      this: NestApplication,
    ) {
      await this.init()
      return this.getHttpServer()
    })
    jest.spyOn(NestFactory, 'create').mockImplementation(async (moduleCls, options) => {
      const app = await realNestCreate(moduleCls, { ...(options as object), logger: false })
      createdApp = app
      return app
    })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await createdApp?.close()
    createdApp = undefined
    process.env = originalEnv
  })

  it('answers a RequestException thrown by a route with statusCode, code and message', async () => {
    // R15: red when main.ts stops calling useGlobalFilters: Nest sends `{ error, code, message, status }`.
    await bootstrap()

    const res = await request(createdApp!.getHttpServer()).post('/v1/probe/conflict')

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      statusCode: 409,
      code: 'WALLET_ALREADY_EXISTS',
      message: 'Ya existe',
    })
  })
})
