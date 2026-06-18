import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { DianProvider, DianInvoiceData, DianResponse } from './dian.interface'
import { SiigoProvider } from './providers/siigo.provider'
import { Invoice, InvoiceType } from '../invoice/entities/invoice.entity'
import { InvoiceItem } from '../invoice/entities/invoiceItem.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { CountryBillingConfigService } from '../billing-profile/country-billing-config.service'
import { AuditService } from '../audit/audit.service'
import { logger } from '../shared/logger/logger'

/**
 * Servicio de facturación electrónica multi-país.
 *
 * Selecciona el provider de facturación electrónica según el país:
 * - CO → Siigo (DIAN Colombia)
 * - MX → SAT México (futuro)
 * - US → No requiere facturación electrónica
 *
 * Fallback: DIAN_PROVIDER en .env para override global.
 */
@Injectable()
export class DianService {
  private defaultProvider: DianProvider | null = null
  private providers = new Map<string, DianProvider>()

  // Datos del emisor (Cubiko)
  private readonly issuer = {
    legalName: process.env.DIAN_ISSUER_NAME || 'CUBIKO S.A.S',
    taxId: process.env.DIAN_ISSUER_NIT || '901234567',
    taxIdType: 'NIT',
    address: process.env.DIAN_ISSUER_ADDRESS || 'Calle 100 #10-20',
    city: process.env.DIAN_ISSUER_CITY || 'Bogotá D.C.',
    country: 'CO',
    email: process.env.DIAN_ISSUER_EMAIL || 'facturacion@cubiko.co',
    phone: process.env.DIAN_ISSUER_PHONE || '+573000000000',
    resolutionNumber: process.env.DIAN_RESOLUTION_NUMBER || '',
    resolutionPrefix: process.env.DIAN_RESOLUTION_PREFIX || 'CK',
  }

  constructor(
    @InjectRepository(Invoice, 'DBWrite')
    private invoiceRepo: Repository<Invoice>,
    @InjectRepository(BillingProfile, 'DBRead')
    private billingProfileRepo: Repository<BillingProfile>,
    private countryConfig: CountryBillingConfigService,
    private auditService: AuditService,
  ) {
    this.initProviders()
  }

  private initProviders() {
    // Registrar providers disponibles por nombre
    const siigo = new SiigoProvider()
    if (siigo.isConfigured()) {
      this.providers.set('siigo', siigo)
      logger.log('info', 'DianService: provider SIIGO registrado')
    }

    // Mock siempre disponible
    this.providers.set('mock', new MockDianProvider())

    // Provider por defecto desde .env (override global)
    const defaultName = process.env.DIAN_PROVIDER || 'mock'
    this.defaultProvider = this.providers.get(defaultName) || this.providers.get('mock')
    logger.log('info', `DianService: provider por defecto = ${defaultName}`)
  }

  /**
   * Obtener el provider correcto para un país.
   * Consulta country_billing_config para determinar cuál usar.
   */
  private async getProviderForCountry(country: string): Promise<DianProvider> {
    const providerName = await this.countryConfig.getElectronicInvoiceProvider(country)
    if (providerName && this.providers.has(providerName)) {
      return this.providers.get(providerName)
    }
    return this.defaultProvider
  }

  /**
   * Enviar factura a la DIAN y actualizar el registro con el CUFE.
   */
  async sendInvoice(invoiceId: string): Promise<DianResponse> {
    const invoice = await this.invoiceRepo.findOne({
      where: { id: invoiceId },
      relations: ['items'],
    })

    if (!invoice) {
      throw new Error('Factura no encontrada')
    }

    if (invoice.dianCufe) {
      throw new Error('Esta factura ya fue enviada a la DIAN')
    }

    const billingProfile = invoice.billingProfileId
      ? await this.billingProfileRepo.findOne({ where: { id: invoice.billingProfileId } })
      : null

    const data = this.buildDianData(invoice, billingProfile)
    const country = billingProfile?.country || 'CO'

    // Verificar si el país requiere facturación electrónica
    const requires = await this.countryConfig.requiresElectronicInvoice(country)
    if (!requires) {
      logger.log('info', `DianService: país ${country} no requiere facturación electrónica, omitiendo`)
      return {
        success: true,
        cufe: `no-required-${country}`,
        status: 'accepted' as const,
        dianMessage: `Facturación electrónica no requerida para ${country}`,
      }
    }

    const provider = await this.getProviderForCountry(country)
    const response = invoice.type === InvoiceType.CREDIT_NOTE
      ? await provider.sendCreditNote(data)
      : await provider.sendInvoice(data)

    // Actualizar factura con CUFE
    if (response.success && response.cufe) {
      invoice.dianCufe = response.cufe
      if (response.pdfUrl) {
        invoice.pdfUrl = response.pdfUrl
      }
      await this.invoiceRepo.save(invoice)
    }

    await this.auditService.log(
      'system',
      response.success ? 'dian_invoice_sent' : 'dian_invoice_failed',
      'invoice',
      invoiceId,
      { cufe: response.cufe, status: response.status, errors: response.errors },
      `Factura ${invoice.invoiceNumber} ${response.success ? 'enviada' : 'rechazada'} por DIAN`,
    )

    return response
  }

  /**
   * Consultar estado de una factura ante la DIAN.
   */
  async checkStatus(invoiceId: string): Promise<any> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } })

    if (!invoice?.dianCufe) {
      throw new Error('Factura no tiene CUFE asignado')
    }

    return this.defaultProvider.getStatus(invoice.dianCufe)
  }

  /**
   * Verificar si el servicio de facturación electrónica está configurado para un país.
   */
  async isConfiguredForCountry(country: string): Promise<boolean> {
    const provider = await this.getProviderForCountry(country)
    return provider?.isConfigured() || false
  }

  /**
   * Verificar si el servicio DIAN está configurado (backward compat).
   */
  isConfigured(): boolean {
    return this.defaultProvider?.isConfigured() || false
  }

  /**
   * Construir datos DIAN desde factura + perfil.
   */
  private buildDianData(invoice: Invoice, profile: BillingProfile | null): DianInvoiceData {
    return {
      invoiceNumber: invoice.invoiceNumber,
      type: invoice.type as 'invoice' | 'credit_note',
      creditNoteForNumber: invoice.creditNoteForId || undefined,
      issuedAt: invoice.issuedAt || invoice.createdAt,
      dueAt: invoice.dueAt || undefined,
      subtotal: parseFloat(String(invoice.subtotal)),
      taxTotal: parseFloat(String(invoice.taxTotal)),
      total: parseFloat(String(invoice.total)),
      currency: invoice.currency,
      items: (invoice.items || []).map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: parseFloat(String(item.unitPrice)),
        subtotal: parseFloat(String(item.subtotal)),
        taxRate: parseFloat(String(item.taxRate)),
        taxAmount: parseFloat(String(item.taxAmount)),
        total: parseFloat(String(item.total)),
      })),
      issuer: this.issuer,
      receiver: profile
        ? {
            legalName: profile.legalName,
            taxId: profile.taxId,
            taxIdType: profile.taxIdType,
            address: profile.address || undefined,
            city: profile.city || undefined,
            country: profile.country,
            email: profile.email,
            phone: profile.phone || undefined,
            taxRegime: profile.taxRegime || undefined,
          }
        : {
            legalName: 'Consumidor Final',
            taxId: '222222222',
            taxIdType: 'CC',
            country: 'CO',
            email: 'sin-email@cubiko.co',
          },
    }
  }
}

/**
 * Provider mock para desarrollo y testing.
 * Genera CUFEs simulados sin enviar a la DIAN.
 */
class MockDianProvider implements DianProvider {
  readonly name = 'mock'

  async sendInvoice(data: DianInvoiceData): Promise<DianResponse> {
    const cufe = this.generateMockCufe(data.invoiceNumber)
    logger.log('info', `[DIAN-MOCK] Factura ${data.invoiceNumber} enviada (CUFE: ${cufe})`)

    return {
      success: true,
      cufe,
      status: 'accepted',
      trackingId: `mock-${Date.now()}`,
      dianMessage: 'Documento aceptado (mock)',
    }
  }

  async sendCreditNote(data: DianInvoiceData): Promise<DianResponse> {
    const cufe = this.generateMockCufe(data.invoiceNumber)
    logger.log('info', `[DIAN-MOCK] Nota crédito ${data.invoiceNumber} enviada (CUFE: ${cufe})`)

    return {
      success: true,
      cufe,
      status: 'accepted',
      trackingId: `mock-cn-${Date.now()}`,
      dianMessage: 'Nota crédito aceptada (mock)',
    }
  }

  async getStatus(trackingId: string): Promise<any> {
    return {
      status: 'accepted',
      cufe: trackingId,
      dianMessage: 'Documento aceptado (mock)',
    }
  }

  isConfigured(): boolean {
    return true
  }

  private generateMockCufe(invoiceNumber: string): string {
    const hash = require('crypto')
      .createHash('sha256')
      .update(`${invoiceNumber}-${Date.now()}`)
      .digest('hex')
    return hash.substring(0, 40)
  }
}
