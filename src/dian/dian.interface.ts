/**
 * Interfaz para proveedores de facturación electrónica DIAN.
 *
 * Proveedores compatibles:
 * - Siigo (https://siigo.com)
 * - Alegra (https://alegra.com)
 * - The Factory HKA (antes Carvajal)
 * - FacturAPI
 *
 * Cada proveedor implementa esta interfaz.
 */

export interface DianInvoiceData {
  // Datos de la factura
  invoiceNumber: string
  type: 'invoice' | 'credit_note'
  creditNoteForNumber?: string

  // Fechas
  issuedAt: Date
  dueAt?: Date

  // Montos
  subtotal: number
  taxTotal: number
  total: number
  currency: string

  // Items
  items: Array<{
    description: string
    quantity: number
    unitPrice: number
    subtotal: number
    taxRate: number
    taxAmount: number
    total: number
  }>

  // Datos del emisor (Cubiko)
  issuer: {
    legalName: string
    taxId: string
    taxIdType: string
    address: string
    city: string
    country: string
    email: string
    phone: string
    resolutionNumber: string
    resolutionPrefix: string
  }

  // Datos del receptor (cliente)
  receiver: {
    legalName: string
    taxId: string
    taxIdType: string
    address?: string
    city?: string
    country: string
    email: string
    phone?: string
    taxRegime?: string
  }
}

export interface DianResponse {
  success: boolean
  cufe: string              // Código Único de Factura Electrónica
  qrCode?: string           // URL del QR code
  xmlUrl?: string           // URL del XML firmado
  pdfUrl?: string           // URL del PDF generado por el proveedor
  trackingId?: string       // ID de seguimiento en la DIAN
  status: 'accepted' | 'rejected' | 'pending'
  dianMessage?: string      // Mensaje de la DIAN
  errors?: string[]
}

export interface DianStatusResponse {
  status: 'accepted' | 'rejected' | 'pending'
  cufe?: string
  dianMessage?: string
  errors?: string[]
}

export interface DianProvider {
  readonly name: string

  /**
   * Enviar factura electrónica a la DIAN.
   */
  sendInvoice(data: DianInvoiceData): Promise<DianResponse>

  /**
   * Enviar nota crédito a la DIAN.
   */
  sendCreditNote(data: DianInvoiceData): Promise<DianResponse>

  /**
   * Consultar estado de un documento ante la DIAN.
   */
  getStatus(trackingId: string): Promise<DianStatusResponse>

  /**
   * Validar que el proveedor está correctamente configurado.
   */
  isConfigured(): boolean
}
