import { Injectable, Logger } from '@nestjs/common'

/** Espejo del contrato de backend-processes `POST /v1/metrics/credit-inputs/batch`. */
export interface CreditInputs {
  brandId: string
  currency: string
  adSpend: number
  revenueMeta: number
  salesDelivered: number
  salesCurrencies: string[]
  coverage: {
    metaFirstDataAt: string | null
    dropiFirstDataAt: string | null
    adAccountCreatedAt: string | null
  }
  fxToBase: {
    currency: string
    rate: number | null
    rateDate: string | null
  }
}

export interface BrandPage {
  data: string[]
  page: number
  pageSize: number
  total: number
}

/**
 * Cliente server-to-server a backend-processes para los insumos de scoring.
 * Mismo patrón que `client-roles.service.ts`: `fetch` nativo, timeout 10s,
 * `Authorization: Bearer ${ACCESS_SERVER}`, URL desde `SERVICE_PROCESSES`.
 */
@Injectable()
export class CreditInputsClient {
  private readonly logger = new Logger(CreditInputsClient.name)
  private readonly baseUrl = process.env.SERVICE_PROCESSES || ''
  private readonly accessServer = process.env.ACCESS_SERVER || ''

  /** Agregados de insumos por marca para el período. Lanza si processes falla. */
  async getBatch(
    brandIds: string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<CreditInputs[]> {
    if (!this.baseUrl) {
      throw new Error('SERVICE_PROCESSES no configurado')
    }

    const response = await fetch(`${this.baseUrl}/v1/metrics/credit-inputs/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessServer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ brandIds, periodStart, periodEnd }),
      signal: AbortSignal.timeout(30000), // batch agregado: más holgura que un GET
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      this.logger.error(`credit-inputs/batch respondió ${response.status}: ${text}`)
      throw new Error(`processes credit-inputs/batch ${response.status}`)
    }

    const body = await response.json()
    return body.data ?? []
  }

  /** Marcas puntuables (Meta∩Dropi), paginadas. Para el run masivo (Fase 3). */
  async discoverBrands(page = 1, pageSize = 100): Promise<BrandPage> {
    if (!this.baseUrl) {
      throw new Error('SERVICE_PROCESSES no configurado')
    }

    const url = `${this.baseUrl}/v1/metrics/credit-inputs/brands?page=${page}&pageSize=${pageSize}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessServer}` },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`processes credit-inputs/brands ${response.status}`)
    }

    return response.json()
  }
}
