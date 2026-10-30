import * as cookieParser from 'cookie-parser'
import helmet from 'helmet'

import { AppModule } from './app.module'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe, RequestMethod } from '@nestjs/common'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { isProductionEnv } from './shared/env/is-production'
import { logger } from './shared/logger/logger'

function requireStartupSecret(name: 'JWT_SECRET' | 'ACCESS_SERVER'): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  if (value !== value.trim() || value === 'CHANGEME') {
    throw new Error(`Invalid required environment variable: ${name}`)
  }
  return value
}

export async function bootstrap() {
  const jwtSecret = requireStartupSecret('JWT_SECRET')
  requireStartupSecret('ACCESS_SERVER')

  const app = await NestFactory.create(AppModule, {
    // NO `cors: true` acá: registraría un CORS por defecto con `origin:'*'` que
    // contesta el preflight OPTIONS antes del `app.enableCors` de abajo. Con
    // `credentials:'include'` + header `Authorization`, el browser rechaza ese
    // wildcard. El CORS real (reflejo de origin + credentials) se configura abajo.
    // Raw body necesario para validar firmas de webhooks (Stripe, MP, Dropi)
    rawBody: true,
  })

  // Prefijo global de versionamiento — el servicio controla su propia versión
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
    ],
  })

  app.use(helmet())
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  app.use(cookieParser(jwtSecret))

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true)
        return
      }
      const url = new URL(origin)
      const domain = url.hostname
      const allowedDomains = process.env.ALLOWED_HOSTS?.split(',') || []
      if (allowedDomains.some((d) => domain.endsWith(d))) {
        callback(null, true)
      } else {
        callback(new Error('Domain not allowed by CORS'))
      }
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Origin, X-Requested-With, Content-Type, Accept, Authorization',
  })

  // Swagger
  const runtimeEnv = process.env.NODE_ENV?.trim() || process.env.ENV?.trim()
  if (!isProductionEnv(process.env) && runtimeEnv === 'development') {
    const config = new DocumentBuilder()
      .setTitle('Backend Payments')
      .setDescription('API de pagos, wallets y suscripciones')
      .setVersion('1.0')
      .addBearerAuth()
      .build()
    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('api', app, document)
  }

  app.enableShutdownHooks()
  await app.listen(80)

  logger.log('info', 'backend-payments running on port 80')
}

if (require.main === module) {
  void bootstrap()
}
