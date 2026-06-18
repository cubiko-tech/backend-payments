import { registerAs } from '@nestjs/config'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, DataSourceOptions } from 'typeorm'

dotenvConfig({ path: '.env' })

const config = {
  type: 'postgres',
  host: `${process.env.POSTGRES_HOST_REPLICA}`,
  port: parseInt(`${process.env.POSTGRES_PORT}`),
  username: `${process.env.POSTGRES_USER}`,
  password: `${process.env.POSTGRES_PASSWORD}`,
  database: `${process.env.POSTGRES_DB}`,
  entities: ['dist/**/*.entity{.ts,.js}'],
  migrations: ['dist/migrations/*{.ts,.js}'],
  autoLoadEntities: true,
  synchronize: false,
}

if (process.env.SSL === 'true') {
  config['ssl'] = { rejectUnauthorized: false }
}

export default registerAs('typeormRead', () => config)
export const connectionSource = new DataSource(config as DataSourceOptions)
