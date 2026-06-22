import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { Request } from 'express'
import { WebhookService } from './webhook.service'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { ConfioProvider } from '../provider/confio/confio.provider'

/**
 * Webhook Controller
 *
 * NOTA: Estos endpoints son PÚBLICOS (sin auth guards).
 * La autenticidad se valida por firma criptográfica del proveedor.
 * En producción, también restringir acceso por IP desde el gateway/firewall.
 */
@ApiTags('Webhook')
@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name)

  constructor(
    private readonly webhookService: WebhookService,
    private readonly stripeProvider: StripeProvider,
    private readonly mercadoPagoProvider: MercadoPagoProvider,
    private readonly dropiProvider: DropiProvider,
    private readonly confioProvider: ConfioProvider,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recibir webhook de Stripe' })
  @ApiResponse({ status: 200, description: 'Webhook recibido correctamente' })
  @ApiResponse({ status: 401, description: 'Firma inválida' })
  async stripe(
    @Headers('stripe-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody
    if (!rawBody || !signature) {
      throw new HttpException('Firma de Stripe requerida', HttpStatus.UNAUTHORIZED)
    }

    if (!this.stripeProvider.validateWebhookSignature(rawBody, signature)) {
      this.logger.warn('Webhook Stripe rechazado: firma inválida')
      throw new HttpException('Firma de Stripe inválida', HttpStatus.UNAUTHORIZED)
    }

    // Construir evento verificado para extraer datos seguros
    const verifiedEvent = this.stripeProvider.constructWebhookEvent(rawBody, signature)

    const eventType = verifiedEvent.type
    const providerEventId = verifiedEvent.id

    return this.webhookService.receive('stripe', eventType, providerEventId, verifiedEvent)
  }

  @Post('mercadopago')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recibir webhook de MercadoPago' })
  @ApiResponse({ status: 200, description: 'Webhook recibido correctamente' })
  @ApiResponse({ status: 401, description: 'Firma inválida' })
  async mercadopago(
    @Headers('x-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody
    if (!rawBody || !signature) {
      throw new HttpException('Firma de MercadoPago requerida', HttpStatus.UNAUTHORIZED)
    }

    if (!this.mercadoPagoProvider.validateWebhookSignature(rawBody, signature)) {
      this.logger.warn('Webhook MercadoPago rechazado: firma inválida')
      throw new HttpException('Firma de MercadoPago inválida', HttpStatus.UNAUTHORIZED)
    }

    // Firma válida — parsear el body
    const payload = JSON.parse(rawBody.toString())
    const eventType = payload?.type || payload?.action || 'unknown'
    const providerEventId = payload?.id?.toString() || `mp_${Date.now()}`

    return this.webhookService.receive('mercadopago', eventType, providerEventId, payload)
  }

  @Post('dropi')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recibir webhook de Dropi' })
  @ApiResponse({ status: 200, description: 'Webhook recibido correctamente' })
  @ApiResponse({ status: 401, description: 'Firma inválida' })
  async dropi(
    @Headers('x-dropi-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody
    if (!rawBody || !signature) {
      throw new HttpException('Firma de Dropi requerida', HttpStatus.UNAUTHORIZED)
    }

    if (!this.dropiProvider.validateWebhookSignature(rawBody, signature)) {
      this.logger.warn('Webhook Dropi rechazado: firma inválida')
      throw new HttpException('Firma de Dropi inválida', HttpStatus.UNAUTHORIZED)
    }

    // Firma válida — parsear el body
    const payload = JSON.parse(rawBody.toString())
    const eventType = payload?.event || payload?.type || 'unknown'
    const providerEventId = payload?.eventId || `dropi_${Date.now()}`

    return this.webhookService.receive('dropi', eventType, providerEventId, payload)
  }

  @Post('confio')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recibir webhook de ConfioPagos' })
  @ApiResponse({ status: 200, description: 'Webhook recibido correctamente' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  async confio(
    @Headers('authorization') authorization: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody
    if (!rawBody) {
      throw new HttpException('Cuerpo del webhook requerido', HttpStatus.BAD_REQUEST)
    }

    // ConfioPagos valida con el mismo access token en Authorization: Bearer.
    const token = (authorization || '').replace(/^Bearer\s+/i, '')
    if (!this.confioProvider.validateWebhookSignature(rawBody, token)) {
      this.logger.warn('Webhook ConfioPagos rechazado: token inválido')
      throw new HttpException('Token de ConfioPagos inválido', HttpStatus.UNAUTHORIZED)
    }

    const payload = JSON.parse(rawBody.toString())
    const eventType = payload?.event || 'unknown'
    // Único por transición de estado del pago (evita procesar dos veces el mismo estado).
    const resourceName = payload?.data?.name || payload?.data?.correlationId || 'unknown'
    const providerEventId = `${resourceName}:${payload?.data?.status || eventType}`

    return this.webhookService.receive('confio', eventType, providerEventId, payload)
  }

  // ============================================
  // Admin — gestión de webhooks fallidos
  // ============================================

  @Get('admin/events')
  @ApiOperation({ summary: 'Listar todos los webhooks con filtros (Admin)' })
  @ApiResponse({ status: 200, description: 'Webhooks con stats' })
  async getAllWebhooks(
    @Query('status') status?: string,
    @Query('provider') provider?: string,
    @Query('limit') limit?: number,
  ) {
    return this.webhookService.getAllWebhooks({ status, provider, limit: limit || 100 })
  }

  @Get('admin/failed')
  @ApiOperation({ summary: 'Listar webhooks fallidos (Admin)' })
  @ApiResponse({ status: 200, description: 'Lista de webhooks fallidos' })
  async getFailedWebhooks(@Query('limit') limit?: number) {
    return this.webhookService.getFailedWebhooks(limit || 50)
  }

  @Post('admin/:id/retry')
  @ApiOperation({ summary: 'Reintentar webhook fallido (Admin)' })
  @ApiResponse({ status: 200, description: 'Reintento encolado' })
  async retryWebhook(@Param('id') id: string) {
    return this.webhookService.retryWebhook(id)
  }
}
