import * as cookieParser from 'cookie-parser'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import { bootstrap } from './main'

jest.mock('cookie-parser', () => jest.fn(() => 'cookie-parser-middleware'))
jest.mock('helmet', () => ({
  __esModule: true,
  default: jest.fn(() => 'helmet-middleware'),
}))
jest.mock('./app.module', () => ({
  AppModule: class AppModule {},
}))
jest.mock('./shared/logger/logger', () => ({
  logger: {
    log: jest.fn(),
  },
}))

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
    jest.clearAllMocks()
    process.env = { ...originalEnv }

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

  it('starts the service and signs cookies with JWT_SECRET when configured', async () => {
    process.env.JWT_SECRET = 'test-cookie-signing-secret'

    await expect(bootstrap()).resolves.toBeUndefined()

    expect(cookieParser).toHaveBeenCalledWith('test-cookie-signing-secret')
    expect(mockApp.use).toHaveBeenCalledWith('cookie-parser-middleware')
    expect(mockApp.listen).toHaveBeenCalledWith(80)
  })
})
