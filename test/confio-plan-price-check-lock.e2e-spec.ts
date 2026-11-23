/**
 * The daily ConfioPagos price check on two replicas against PostgreSQL: the advisory lock only
 * exists in the database, so a data source double would let both runs through.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource } from 'typeorm'

import { ClientRolesService } from '../src/client/client-roles.service'
import { ConfioPlanPriceCheckService } from '../src/provider/confio/confio-plan-price-check.service'
import { ConfioPlanService } from '../src/provider/confio/confio-plan.service'

dotenvConfig({ path: '.env' })

describe('Daily price check lock across replicas (PostgreSQL, LOC-322)', () => {
  let dataSource: DataSource

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [],
      synchronize: false,
    })
    await dataSource.initialize()
  })

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy()
  })

  it('a second replica that starts while the first holds the lock does not run the check', async () => {
    // Mutation: takeRun returns `taken: true` whatever the lock query says, both run.
    let runs = 0
    let second: ConfioPlanPriceCheckService | undefined
    // R17: the mappings read is where a run starts; the first one starts the other replica inside it.
    const planes = {
      findAllMappings: jest.fn(async () => {
        runs++
        if (runs === 1) await second!.verificarPreciosContraElCatalogo()
        return []
      }),
    }
    // R17: backend-roles is another service; with no mappings no price is ever asked.
    const clientRoles = { getPlanPriceCents: jest.fn() }
    const replica = () =>
      new ConfioPlanPriceCheckService(
        planes as unknown as ConfioPlanService,
        clientRoles as unknown as ClientRolesService,
        dataSource,
      )
    const first = replica()
    second = replica()

    await first.verificarPreciosContraElCatalogo()
    const afterwards = runs
    await second.verificarPreciosContraElCatalogo()

    expect(afterwards).toBe(1)
    expect(runs).toBe(2)
  })
})
