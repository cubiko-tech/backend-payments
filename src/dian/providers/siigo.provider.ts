import { DianProvider, DianInvoiceData, DianResponse, DianStatusResponse } from '../dian.interface'
import { logger } from '../../shared/logger/logger'

/**
 * Proveedor de facturación electrónica Siigo.
 *
 * API Docs: https://siigo.docs.apiary.io / https://siigoapi.docs.apiary.io
 *
 * Flujo de autenticación:
 * 1. POST /auth → obtener access_token con username + access_key
 * 2. Usar token en todas las llamadas posteriores
 * 3. Token expira en 24h, renovar automáticamente
 *
 * Flujo de facturación:
 * 1. POST /v1/invoices → crear factura en Siigo (genera XML, firma, envía a DIAN)
 * 2. Siigo retorna CUFE + estado de la DIAN
 * 3. GET /v1/invoices/{id} → consultar estado
 *
 * Variables de entorno requeridas:
 * - SIIGO_API_URL (default: https://api.siigo.com)
 * - SIIGO_USERNAME (email de la cuenta Siigo)
 * - SIIGO_ACCESS_KEY (access key generado en Siigo)
 */
export class SiigoProvider implements DianProvider {
  readonly name = 'siigo'

  private apiUrl: string
  private username: string
  private accessKey: string
  private accessToken: string | null = null
  private tokenExpiresAt: Date | null = null

  constructor() {
    this.apiUrl = process.env.SIIGO_API_URL || 'https://api.siigo.com'
    this.username = process.env.SIIGO_USERNAME || ''
    this.accessKey = process.env.SIIGO_ACCESS_KEY || ''

    if (this.isConfigured()) {
      logger.log('info', 'SiigoProvider: inicializado correctamente')
    }
  }

  isConfigured(): boolean {
    return !!(this.username && this.accessKey)
  }

  // =============================================================
  // Autenticación
  // =============================================================

  private async authenticate(): Promise<void> {
    // Si el token aún es válido, no renovar
    if (this.accessToken && this.tokenExpiresAt && new Date() < this.tokenExpiresAt) {
      return
    }

    const response = await fetch(`${this.apiUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        access_key: this.accessKey,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Siigo auth error: ${response.status} - ${error}`)
    }

    const body = await response.json()
    this.accessToken = body.access_token
    // Token expira en 24h, renovamos 1h antes por seguridad
    this.tokenExpiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000)

    logger.log('info', 'SiigoProvider: token renovado')
  }

  private async siigoFetch(path: string, options: RequestInit = {}): Promise<any> {
    await this.authenticate()

    const response = await fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Partner-Id': 'cubiko',
        ...options.headers,
      },
      signal: AbortSignal.timeout(30000),
    })

    const body = await response.json()

    if (!response.ok) {
      logger.log('error', `Siigo API error: ${response.status}`, body)
      throw new Error(`Siigo error: ${body.Errors?.[0]?.Message || response.statusText}`)
    }

    return body
  }

  // =============================================================
  // Facturación
  // =============================================================

  async sendInvoice(data: DianInvoiceData): Promise<DianResponse> {
    if (!this.isConfigured()) {
      throw new Error('SiigoProvider no está configurado')
    }

    const siigoPayload = this.buildInvoicePayload(data)

    try {
      const result = await this.siigoFetch('/v1/invoices', {
        method: 'POST',
        body: JSON.stringify(siigoPayload),
      })

      return {
        success: true,
        cufe: result.stamp?.cufe || result.id,
        qrCode: result.stamp?.qr_code || undefined,
        xmlUrl: result.xml_url || undefined,
        pdfUrl: result.pdf_url || undefined,
        trackingId: String(result.id),
        status: 'accepted',
        dianMessage: 'Factura aceptada por la DIAN',
      }
    } catch (error) {
      return {
        success: false,
        cufe: '',
        status: 'rejected',
        dianMessage: error.message,
        errors: [error.message],
      }
    }
  }

  async sendCreditNote(data: DianInvoiceData): Promise<DianResponse> {
    if (!this.isConfigured()) {
      throw new Error('SiigoProvider no está configurado')
    }

    const siigoPayload = this.buildCreditNotePayload(data)

    try {
      const result = await this.siigoFetch('/v1/credit-notes', {
        method: 'POST',
        body: JSON.stringify(siigoPayload),
      })

      return {
        success: true,
        cufe: result.stamp?.cufe || result.id,
        qrCode: result.stamp?.qr_code || undefined,
        pdfUrl: result.pdf_url || undefined,
        trackingId: String(result.id),
        status: 'accepted',
        dianMessage: 'Nota crédito aceptada por la DIAN',
      }
    } catch (error) {
      return {
        success: false,
        cufe: '',
        status: 'rejected',
        dianMessage: error.message,
        errors: [error.message],
      }
    }
  }

  async getStatus(trackingId: string): Promise<DianStatusResponse> {
    if (!this.isConfigured()) {
      throw new Error('SiigoProvider no está configurado')
    }

    try {
      const result = await this.siigoFetch(`/v1/invoices/${trackingId}`)

      return {
        status: result.stamp?.status === 'Accepted' ? 'accepted' : 'pending',
        cufe: result.stamp?.cufe,
        dianMessage: result.stamp?.status || 'Consultado',
      }
    } catch (error) {
      return {
        status: 'pending',
        dianMessage: error.message,
        errors: [error.message],
      }
    }
  }

  // =============================================================
  // Builders de payload Siigo
  // =============================================================

  /**
   * Construir payload de factura para la API de Siigo.
   * Referencia: https://siigoapi.docs.apiary.io/#reference/invoices/create-invoice
   */
  private buildInvoicePayload(data: DianInvoiceData) {
    return {
      document: {
        id: this.getDocumentTypeId('invoice'),
      },
      date: this.formatSiigoDate(data.issuedAt),
      customer: this.buildCustomer(data.receiver),
      seller: this.getSellerId(),
      observations: `Factura ${data.invoiceNumber}`,
      items: data.items.map((item) => ({
        code: 'SRV-001', // Código genérico de servicio
        description: item.description,
        quantity: item.quantity,
        price: item.unitPrice,
        discount: 0,
        taxes: item.taxRate > 0
          ? [
              {
                id: this.getTaxId(item.taxRate),
                name: 'IVA',
                percentage: item.taxRate * 100,
                value: item.taxAmount,
              },
            ]
          : [],
      })),
      payments: [
        {
          id: this.getPaymentMethodId(),
          value: data.total,
          due_date: this.formatSiigoDate(data.dueAt || data.issuedAt),
        },
      ],
      currency_code: data.currency,
      total: data.total,
    }
  }

  /**
   * Construir payload de nota crédito para la API de Siigo.
   */
  private buildCreditNotePayload(data: DianInvoiceData) {
    return {
      document: {
        id: this.getDocumentTypeId('credit_note'),
      },
      date: this.formatSiigoDate(data.issuedAt),
      customer: this.buildCustomer(data.receiver),
      seller: this.getSellerId(),
      observations: `Nota crédito para factura ${data.creditNoteForNumber || data.invoiceNumber}`,
      // Referencia a la factura original
      reason: {
        description: `Nota crédito - ${data.invoiceNumber}`,
      },
      items: data.items.map((item) => ({
        code: 'SRV-001',
        description: item.description,
        quantity: item.quantity,
        price: item.unitPrice,
        discount: 0,
        taxes: item.taxRate > 0
          ? [
              {
                id: this.getTaxId(item.taxRate),
                name: 'IVA',
                percentage: item.taxRate * 100,
                value: item.taxAmount,
              },
            ]
          : [],
      })),
      payments: [
        {
          id: this.getPaymentMethodId(),
          value: data.total,
        },
      ],
      currency_code: data.currency,
      total: data.total,
    }
  }

  /**
   * Construir datos del cliente para Siigo.
   * Si el cliente no existe en Siigo, se usa el "Consumidor Final" genérico.
   */
  private buildCustomer(receiver: DianInvoiceData['receiver']) {
    return {
      identification: {
        code: receiver.taxIdType === 'NIT' ? '31' : '13', // 31=NIT, 13=CC
        number: receiver.taxId,
      },
      name: [receiver.legalName],
      address: {
        address: receiver.address || 'Sin dirección',
        city: {
          // Código DANE de Bogotá por defecto
          country_code: receiver.country || 'CO',
          state_code: '11',
          city_code: '11001',
        },
      },
      phones: receiver.phone
        ? [{ number: receiver.phone }]
        : [],
      contacts: [
        {
          first_name: receiver.legalName,
          email: receiver.email,
        },
      ],
      fiscal_responsibilities: this.getFiscalResponsibilities(receiver.taxRegime),
    }
  }

  // =============================================================
  // Helpers de configuración Siigo
  // =============================================================

  /**
   * ID del tipo de documento en Siigo.
   * Estos IDs se obtienen de GET /v1/document-types
   * y se configuran en variables de entorno.
   */
  private getDocumentTypeId(type: string): number {
    const ids = {
      invoice: parseInt(process.env.SIIGO_DOCUMENT_TYPE_INVOICE || '24460'),
      credit_note: parseInt(process.env.SIIGO_DOCUMENT_TYPE_CREDIT_NOTE || '24461'),
    }
    return ids[type] || ids.invoice
  }

  /**
   * ID del vendedor en Siigo.
   */
  private getSellerId(): number {
    return parseInt(process.env.SIIGO_SELLER_ID || '1')
  }

  /**
   * ID del método de pago en Siigo.
   * Los IDs se obtienen de GET /v1/payment-types
   */
  private getPaymentMethodId(): number {
    return parseInt(process.env.SIIGO_PAYMENT_METHOD_ID || '5636')
  }

  /**
   * ID del impuesto en Siigo según la tasa.
   */
  private getTaxId(taxRate: number): number {
    // IVA 19% = ID estándar en Siigo
    if (Math.abs(taxRate - 0.19) < 0.01) {
      return parseInt(process.env.SIIGO_TAX_IVA_19_ID || '1')
    }
    // IVA 5%
    if (Math.abs(taxRate - 0.05) < 0.01) {
      return parseInt(process.env.SIIGO_TAX_IVA_5_ID || '2')
    }
    return 1 // Default IVA 19%
  }

  /**
   * Responsabilidades fiscales para Siigo.
   */
  private getFiscalResponsibilities(taxRegime?: string): Array<{ code: string }> {
    switch (taxRegime) {
      case 'responsable_iva':
        return [{ code: 'O-48' }] // Responsable del IVA
      case 'no_responsable':
        return [{ code: 'R-99-PN' }] // No responsable
      case 'gran_contribuyente':
        return [{ code: 'O-13' }] // Gran contribuyente
      default:
        return [{ code: 'R-99-PN' }] // Default: no responsable
    }
  }

  /**
   * Formatear fecha para Siigo (YYYY-MM-DD).
   */
  private formatSiigoDate(date: Date | string): string {
    const d = date instanceof Date ? date : new Date(date)
    return d.toISOString().split('T')[0]
  }
}
