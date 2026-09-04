import { createLogger, format, transports } from 'winston'

import { isProductionEnv } from '../env/is-production'

export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  defaultMeta: { service: 'backend-payments' },
  transports: [
    new transports.File({ filename: 'error.log', level: 'error' }),
    new transports.File({ filename: 'combined.log' }),
  ],
})

// `isProductionEnv()` y no `NODE_ENV`: esta grafía no existe en la configuración
// del servicio (`.env.schema` declara `ENV`), así que la consola con formato para
// humanos se agregaba también corriendo en producción.
if (!isProductionEnv()) {
  logger.add(
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  )
}
