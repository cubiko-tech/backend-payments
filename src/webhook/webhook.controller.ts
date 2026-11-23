import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Query,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { Request } from 'express'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSessionUser, RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import { WebhookService } from './webhook.service'
import {
  ListFailedWebhooksQueryDto,
  ListWebhookEventsQueryDto,
} from './dto/webhook-admin-query.dto'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { ConfioProvider } from '../provider/confio/confio.provider'
import {
  buildConfioWebhookEventId,
  classifyConfioWebhookEvent,
} from '../provider/confio/confio-webhook'
import {
  timingSafeEqualStrings,
  verifyConfioWebhookSignature,
} from '../provider/confio/confio-webhook-signature'
import { readConfioWebhookKey } from '../provider/confio/confio-webhook-env'
import { ConfioWebhookPayload } from '../provider/confio/confio.types'
import { escapeLogValue } from '../shared/logger/log-value'

/**
 * Rejection log fields when signature verification has not happened yet (bad bearer or body):
 * those fields do not exist, and saying so beats inventing them.
 */
const SIN_CAMPOS_DE_FIRMA = 'signature.properties=no aplica data=no aplica'

/**
 * Payload fields logged with a rejection AFTER signature verification: the property set the sender
 * declared and the keys of `data`. Never the expected digest or the key.
 */
function camposDeFirma(payload: ConfioWebhookPayload): string {
  const properties = payload?.signature?.properties
  const declared = Array.isArray(properties) ? escapeLogValue(properties.join(',')) : 'ausente'
  const data = payload?.data
  const keys =
    data && typeof data === 'object' ? escapeLogValue(Object.keys(data).join(',')) : 'ausente'

  return `signature.properties=[${declared}] data=[${keys}]`
}

/**
 * The only controller in the service without a class-level guard, so auth must be checked per handler.
 *
 * Provider `@Post` handlers are public on purpose: authenticity comes from the sender's signature or
 * bearer, the only credential an external provider can send. Restricting by IP at the gateway helps too.
 *
 * The `admin/*` handlers are NOT public: each one carries its own `@UseGuards(ApiAuthGuard)`.
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

  // Read once at construction: rotating CONFIO_WEBHOOK_KEY requires a service restart.
  private readonly webhookKey = readConfioWebhookKey()

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

    const payload = JSON.parse(rawBody.toString())
    const eventType = payload?.type || payload?.action || 'unknown'
    const providerEventId = this.mercadoPagoProvider.webhookEventId(rawBody, signature)

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

    const payload = JSON.parse(rawBody.toString())
    const eventType = payload?.event || payload?.type || 'unknown'
    const providerEventId = this.dropiProvider.webhookEventId(rawBody, payload)

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

    const bearer = (authorization || '').replace(/^Bearer\s+/i, '')

    // Parse first: the branch (which bearer is expected, whether a signature exists) depends on `event`.
    const payload = this.parsearWebhookConfio(rawBody)

    // Unknown events are never dispatched but get 200 so Confio stops retrying. They must still
    // authenticate first, else anyone could probe which events exist and flood the log (CWE-306).
    const ramo = classifyConfioWebhookEvent(payload.event)
    if (ramo === 'fuera_de_contrato') {
      this.autenticarRamoOneShot(rawBody, bearer)

      this.logger.warn(
        `Webhook ConfioPagos ignorado: evento fuera del contrato "${escapeLogValue(payload.event)}"`,
      )
      // Kept as `ignored` and never dispatched; the answer stays the same.
      await this.webhookService.recordIgnored(
        'confio',
        typeof payload.event === 'string' ? payload.event : 'unknown',
        buildConfioWebhookEventId(payload),
        payload,
      )

      return { ignored: true }
    }

    if (ramo === 'firmado') this.autenticarRamoFirmado(payload, bearer)
    else this.autenticarRamoOneShot(rawBody, bearer)

    const eventType = payload?.event || 'unknown'
    // The key identifies the notification, not the delivery attempt, so redeliveries dedupe.
    const providerEventId = buildConfioWebhookEventId(payload)

    return this.webhookService.receive('confio', eventType, providerEventId, payload)
  }

  /**
   * `null`, `[]` and `"x"` are valid JSON but not an envelope; without this check they would reach
   * the ignored-200 path with `event: undefined` instead of being rejected.
   */
  private parsearWebhookConfio(rawBody: Buffer): ConfioWebhookPayload {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody.toString())
    } catch {
      throw this.rechazarWebhookConfio('invalid_json', SIN_CAMPOS_DE_FIRMA, 'el cuerpo no es JSON')
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw this.rechazarWebhookConfio(
        'invalid_json',
        SIN_CAMPOS_DE_FIRMA,
        'el cuerpo es JSON pero no un objeto',
      )
    }

    return parsed as ConfioWebhookPayload
  }

  /**
   * Signed branch (the two subscription events): bearer + checksum.
   *
   * The missing-key policy belongs to this branch only: one-shot events never carry `signature` and
   * authenticate with the access token, so applying it there would block live charges.
   *
   * Without a key it rejects in EVERY environment: a `CANCELED` status revokes the brand plan in
   * backend-roles, an irreversible cross-service effect that must never fail open. Every environment
   * that receives these events therefore needs `CONFIO_WEBHOOK_KEY` set.
   */
  private autenticarRamoFirmado(payload: ConfioWebhookPayload, bearer: string): void {
    if (!this.webhookKey) {
      this.logger.error(
        `Webhook ConfioPagos rechazado: reason=missing_key ${SIN_CAMPOS_DE_FIRMA} ` +
          'detail=CONFIO_WEBHOOK_KEY vacía o CHANGEME',
      )
      throw new HttpException('Webhook de ConfioPagos rechazado', HttpStatus.UNAUTHORIZED)
    }

    // Bearer before checksum: it is the cheap check, and it is constant-time like the digest.
    if (!timingSafeEqualStrings(bearer, this.webhookKey)) {
      throw this.rechazarWebhookConfio(
        'bearer_mismatch',
        SIN_CAMPOS_DE_FIRMA,
        'el Authorization no coincide con CONFIO_WEBHOOK_KEY',
      )
    }

    const verdict = verifyConfioWebhookSignature(payload, this.webhookKey)
    if (verdict.signed === false) {
      throw this.rechazarWebhookConfio(verdict.reason, camposDeFirma(payload), verdict.detail)
    }
  }

  /**
   * One-shot branch (payment link): live traffic that arrives without `signature`.
   *
   * Both bearers are accepted (access token and webhook key) because it is unconfirmed which one
   * Confio sends once the URL is registered, and provisioning the key must not block live charges.
   */
  private autenticarRamoOneShot(rawBody: Buffer, bearer: string): void {
    const conAccessToken = this.confioProvider.validateWebhookSignature(rawBody, bearer)
    const conClaveDeWebhook = !!this.webhookKey && timingSafeEqualStrings(bearer, this.webhookKey)

    if (!conAccessToken && !conClaveDeWebhook) {
      throw this.rechazarWebhookConfio(
        'bearer_mismatch',
        SIN_CAMPOS_DE_FIRMA,
        'el Authorization no coincide ni con CONFIO_ACCESS_TOKEN ni con CONFIO_WEBHOOK_KEY',
      )
    }
  }

  /** Logs exactly one line per rejection and returns the 401 to throw. */
  private rechazarWebhookConfio(reason: string, campos: string, detail: string): HttpException {
    this.logger.warn(
      `Webhook ConfioPagos rechazado: reason=${reason} ${campos} detail="${escapeLogValue(detail)}"`,
    )

    return new HttpException('Webhook de ConfioPagos rechazado', HttpStatus.UNAUTHORIZED)
  }

  // Admin handlers: each MUST carry its own guard, since a class guard would block provider webhooks.
  // `controllers-guarded.spec.ts` pins both halves so fixing one cannot break the other.

  @Get('admin/events')
  @UseGuards(ApiAuthGuard)
  @RequireSuperAdmin()
  @ApiOperation({ summary: 'Listar todos los webhooks con filtros (Admin)' })
  @ApiResponse({ status: 200, description: 'Webhooks con stats' })
  async getAllWebhooks(@Query() query?: ListWebhookEventsQueryDto) {
    return this.webhookService.getAllWebhooks({
      status: query?.status,
      provider: query?.provider,
      limit: query?.limit || 100,
    })
  }

  @Get('admin/failed')
  @UseGuards(ApiAuthGuard)
  @RequireSuperAdmin()
  @ApiOperation({ summary: 'Listar webhooks fallidos (Admin)' })
  @ApiResponse({ status: 200, description: 'Lista de webhooks fallidos' })
  async getFailedWebhooks(@Query() query?: ListFailedWebhooksQueryDto) {
    return this.webhookService.getFailedWebhooks(query?.limit || 50)
  }

  @Post('admin/:id/retry')
  @UseGuards(ApiAuthGuard)
  @RequireSuperAdmin()
  @RequireSessionUser()
  @ApiOperation({ summary: 'Reintentar webhook fallido (Admin)' })
  @ApiResponse({ status: 200, description: 'Reintento encolado' })
  async retryWebhook(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhookService.retryWebhook(id)
  }
}
