import { Logger } from '@nestjs/common'
import { Client } from 'pg'

const logger = new Logger('CreateDatabase')

// Validate required environment variables
const requiredEnvVars = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
]

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`)
    process.exit(1)
  }
}

// Database configuration
const config = {
  host: process.env.POSTGRES_HOST!,
  port: parseInt(process.env.POSTGRES_PORT!, 10),
  user: process.env.POSTGRES_USER!,
  password: process.env.POSTGRES_PASSWORD!,
  database: 'postgres',
}

// Configuration for SSL connection
// Note: In production, always use proper CA certificates for SSL validation
if (process.env.SSL === 'true') {
  config['ssl'] = process.env.SSL_CA_CERT
    ? {
        // Use CA certificate if provided (recommended for production)
        ca: process.env.SSL_CA_CERT,
        rejectUnauthorized: true,
      }
    : {
        // Fallback: Only for development/testing when CA is not available
        // ⚠️ WARNING: This is insecure and should never be used in production
        rejectUnauthorized: process.env.NODE_ENV !== 'production',
      }
}

const createDatabaseIfNotExists = async () => {
  const dbName = process.env.POSTGRES_DB!
  const client = new Client(config)

  try {
    await client.connect()

    const result = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName],
    )

    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`)
      logger.log(`Database '${dbName}' created successfully`)
    } else {
      logger.log(`Database '${dbName}' already exists`)
    }
  } catch (err) {
    logger.error(
      `Failed to verify/create database '${dbName}': ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  } finally {
    await client.end()
  }
}

createDatabaseIfNotExists()
