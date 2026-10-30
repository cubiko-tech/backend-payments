import * as cookieParser from 'cookie-parser'
import helmet from 'helmet'
import * as request from 'supertest'
import { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import { bootstrap } from './main'

jest.mock('cookie-parser', () => jest.fn(() => 'cookie-parser-middleware'))
jest.mock('helmet', () => ({
  __esModule: true,
  default: jest.fn(() => 'helmet-middleware'),
}))
jest.mock('./app.module', () => {
  const { Module } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common')
  @Module({})
  class AppModule {}
  return { AppModule }
})
jest.mock('./shared/logger/logger', () => ({
  logger: {
    log: jest.fn(),
  },
}))

const realNestCreate = NestFactory.create.bind(NestFactory)

describe('bootstrap (JWT_SECRET requirement)', () => {
  const originalEnv = process.env
  let mockApp: {
    setGlobalPrefix: jest.Mock
    use: jest.Mock
    useGlobalPipes: jest.Mock
    enableCors: jest.Mock
    enableShutdownHooks: jest.Mock
    listen: jest.Mock
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-cookie-signing-secret',
      ACCESS_SERVER: 'test-access-server-secret',
    }
    ;(cookieParser as unknown as jest.Mock).mockReturnValue('cookie-parser-middleware')
    ;(helmet as unknown as jest.Mock).mockReturnValue('helmet-middleware')

    mockApp = {
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      useGlobalPipes: jest.fn(),
      enableCors: jest.fn(),
      enableShutdownHooks: jest.fn(),
      listen: jest.fn().mockResolvedValue(undefined),
    }

    jest.spyOn(NestFactory, 'create').mockResolvedValue(mockApp as never)
    jest.spyOn(SwaggerModule, 'createDocument').mockReturnValue({} as never)
    jest.spyOn(SwaggerModule, 'setup').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('refuses to start and names JWT_SECRET when the variable is missing', async () => {
    delete process.env.JWT_SECRET

    await expect(bootstrap()).rejects.toThrow(/JWT_SECRET/)
    expect(mockApp.listen).not.toHaveBeenCalled()
  })

  it.each(['', '   '])(
    'refuses to start and names JWT_SECRET when the variable is blank (%j)',
    async (blankValue) => {
      process.env.JWT_SECRET = blankValue

      await expect(bootstrap()).rejects.toThrow(/JWT_SECRET/)
      expect(mockApp.listen).not.toHaveBeenCalled()
    },
  )

  it.each(['CHANGEME', ' leading-secret', 'trailing-secret ', ' CHANGEME '])(
    'refuses to start and names JWT_SECRET without exposing its value when set to %j',
    async (invalidSecret) => {
      process.env.JWT_SECRET = invalidSecret

      let caughtError: Error | undefined
      try {
        await bootstrap()
      } catch (err) {
        caughtError = err as Error
      }

      expect(caughtError).toBeInstanceOf(Error)
      expect(caughtError?.message).toMatch(/JWT_SECRET/)
      expect(caughtError?.message).not.toContain(invalidSecret.trim())
      expect(mockApp.listen).not.toHaveBeenCalled()
    },
  )

  it('refuses to start and names ACCESS_SERVER when the variable is missing', async () => {
    delete process.env.ACCESS_SERVER

    await expect(bootstrap()).rejects.toThrow(/ACCESS_SERVER/)
    expect(mockApp.listen).not.toHaveBeenCalled()
  })

  it.each(['', '   '])(
    'refuses to start and names ACCESS_SERVER when the variable is blank (%j)',
    async (blankValue) => {
      process.env.ACCESS_SERVER = blankValue

      await expect(bootstrap()).rejects.toThrow(/ACCESS_SERVER/)
      expect(mockApp.listen).not.toHaveBeenCalled()
    },
  )

  it.each(['CHANGEME', ' leading-token', 'trailing-token ', ' CHANGEME '])(
    'refuses to start and names ACCESS_SERVER without exposing its value when set to %j',
    async (invalidSecret) => {
      process.env.ACCESS_SERVER = invalidSecret

      let caughtError: Error | undefined
      try {
        await bootstrap()
      } catch (err) {
        caughtError = err as Error
      }

      expect(caughtError).toBeInstanceOf(Error)
      expect(caughtError?.message).toMatch(/ACCESS_SERVER/)
      expect(caughtError?.message).not.toContain(invalidSecret.trim())
      expect(mockApp.listen).not.toHaveBeenCalled()
    },
  )

  it('starts the service and signs cookies with JWT_SECRET when configured', async () => {
    process.env.JWT_SECRET = 'test-cookie-signing-secret'
    process.env.ACCESS_SERVER = 'test-access-server-secret'

    await expect(bootstrap()).resolves.toBeUndefined()

    expect(cookieParser).toHaveBeenCalledWith('test-cookie-signing-secret')
    expect(mockApp.use).toHaveBeenCalledWith('cookie-parser-middleware')
    expect(mockApp.listen).toHaveBeenCalledWith(80)
  })

  it('starts the service with deterministic local-shaped secrets even when webhook secrets are CHANGEME', async () => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'localdevjwt',
      ACCESS_SERVER: 'local_access_server_token_0123456789abcdef0123456789',
      CONFIO_WEBHOOK_KEY: 'CHANGEME',
      DROPI_WEBHOOK_SECRET: 'CHANGEME',
      STRIPE_WEBHOOK_SECRET: 'CHANGEME',
      MP_WEBHOOK_SECRET: 'CHANGEME',
    }

    await expect(bootstrap()).resolves.toBeUndefined()
    expect(cookieParser).toHaveBeenCalledWith('localdevjwt')
    expect(mockApp.listen).toHaveBeenCalledWith(80)
  })
})

describe('bootstrap (Swagger documentation exposure by environment)', () => {
  const originalEnv = process.env
  let createdApp: INestApplication | undefined

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-cookie-signing-secret',
      ACCESS_SERVER: 'test-access-server-secret',
    }
    delete process.env.ENV
    delete process.env.GO_ENV
    delete process.env.NODE_ENV
    ;(cookieParser as unknown as jest.Mock).mockImplementation(
      () => (_req: unknown, _res: unknown, next: () => void) => next(),
    )
    ;(helmet as unknown as jest.Mock).mockImplementation(
      () => (_req: unknown, _res: unknown, next: () => void) => next(),
    )

    jest.spyOn(NestFactory, 'create').mockImplementation(async (moduleCls, options) => {
      const app = await realNestCreate(moduleCls, { ...(options as object), logger: false })
      createdApp = app
      app.listen = jest.fn(async () => {
        await app.init()
        return app.getHttpServer()
      }) as never
      return app
    })
  })

  afterEach(async () => {
    try {
      if (createdApp) {
        await createdApp.close()
      }
    } finally {
      createdApp = undefined
      process.env = originalEnv
    }
  })

  it('returns 404 on GET /api and GET /api-json without session when NODE_ENV is production', async () => {
    process.env.ENV = 'development'
    process.env.NODE_ENV = 'production'

    await bootstrap()

    const httpServer = createdApp!.getHttpServer()
    const apiResponse = await request(httpServer).get('/api')
    const apiJsonResponse = await request(httpServer).get('/api-json')

    expect(apiResponse.status).toBe(404)
    expect(apiJsonResponse.status).toBe(404)
  })

  it.each(['staging', 'test'])(
    'returns 404 on GET /api and GET /api-json when NODE_ENV is %s',
    async (nonDevEnv) => {
      process.env.NODE_ENV = nonDevEnv

      await bootstrap()

      const httpServer = createdApp!.getHttpServer()
      const apiResponse = await request(httpServer).get('/api')
      const apiJsonResponse = await request(httpServer).get('/api-json')

      expect(apiResponse.status).toBe(404)
      expect(apiJsonResponse.status).toBe(404)
    },
  )

  it.each(['production', 'staging'])(
    'returns 404 on GET /api and GET /api-json when NODE_ENV is unset and ENV is %s',
    async (nonDevEnv) => {
      process.env.ENV = nonDevEnv

      await bootstrap()

      const httpServer = createdApp!.getHttpServer()
      const apiResponse = await request(httpServer).get('/api')
      const apiJsonResponse = await request(httpServer).get('/api-json')

      expect(apiResponse.status).toBe(404)
      expect(apiJsonResponse.status).toBe(404)
    },
  )

  it('serves Swagger on GET /api and GET /api-json with 200 when NODE_ENV is development', async () => {
    process.env.NODE_ENV = 'development'

    await bootstrap()

    const httpServer = createdApp!.getHttpServer()
    const apiResponse = await request(httpServer).get('/api')
    const apiJsonResponse = await request(httpServer).get('/api-json')

    expect(apiResponse.status).toBe(200)
    expect(apiJsonResponse.status).toBe(200)
    expect(apiJsonResponse.body?.info?.title).toBe('Backend Payments')
  })

  it('serves Swagger on GET /api and GET /api-json with 200 in local dev when ENV is development and NODE_ENV is unset', async () => {
    process.env.ENV = 'development'

    await bootstrap()

    const httpServer = createdApp!.getHttpServer()
    const apiResponse = await request(httpServer).get('/api')
    const apiJsonResponse = await request(httpServer).get('/api-json')

    expect(apiResponse.status).toBe(200)
    expect(apiJsonResponse.status).toBe(200)
    expect(apiJsonResponse.body?.info?.title).toBe('Backend Payments')
  })
})
