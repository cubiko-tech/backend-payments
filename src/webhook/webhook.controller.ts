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
import { buildConfioWebhookEventId, classifyConfioWebhookEvent } from '../provider/confio/confio-webhook'
import {
  timingSafeEqualStrings,
  verifyConfioWebhookSignature,
} from '../provider/confio/confio-webhook-signature'
import { readConfioWebhookKey } from '../provider/confio/confio-webhook-env'
import { ConfioWebhookPayload } from '../provider/confio/confio.types'

/**
 * Webhook Controller
 *
 * NOTA: Estos endpoints son PÚBLICOS (sin auth guards).
 * La autenticidad se valida por firma criptográfica del proveedor.
 * En producción, también restringir acceso por IP desde el gateway/firewall.
 */
/**
 * Lo que se pone en la línea de rechazo cuando todavía NO hubo verificación de
 * firma (bearer o cuerpo inválidos): esos campos no existen, y decirlo vale más
 * que inventarlos.
 */
const SIN_CAMPOS_DE_FIRMA = 'signature.properties=no aplica data=no aplica'

/** Tope de caracteres de cada eco del emisor dentro de una línea de log. */
const ECO_DE_LOG_MAX = 120

/**
 * Normaliza un valor QUE VIENE DEL EMISOR antes de loguearlo: sin esto un
 * `event` con saltos de línea o secuencias ANSI forja líneas de log, y una lista
 * de `properties` larguísima infla cada rechazo. Espeja a `echoForDetail` de
 * `confio-webhook-signature.ts`, que no se exporta.
 */
function ecoDeLog(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value)
  const clean = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')

  return clean.length > ECO_DE_LOG_MAX ? `${clean.slice(0, ECO_DE_LOG_MAX)}…` : clean
}

/**
 * Campos del payload que acompañan a un rechazo POSTERIOR a la verificación de
 * firma: el conjunto declarado por el emisor y las claves de `data`. Nunca el
 * digest esperado ni la clave.
 */
function camposDeFirma(payload: ConfioWebhookPayload): string {
  const properties = payload?.signature?.properties
  const declared = Array.isArray(properties) ? ecoDeLog(properties.join(',')) : 'ausente'
  const data = payload?.data
  const keys = data && typeof data === 'object' ? ecoDeLog(Object.keys(data).join(',')) : 'ausente'

  return `signature.properties=[${declared}] data=[${keys}]`
}

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

  // Entorno leído UNA sola vez, al construir —mismo hábito que `ConfioProvider`—:
  // rotar CONFIO_WEBHOOK_KEY exige reiniciar el servicio.
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

    const bearer = (authorization || '').replace(/^Bearer\s+/i, '')

    // El parseo va PRIMERO porque el ramo —y con él qué bearer se espera y si
    // hay firma que verificar— no se puede saber sin leer el `event`.
    const payload = this.parsearWebhookConfio(rawBody)

    // Fuera del contrato: no sabemos cómo autenticarlo, así que no se despacha.
    // Se responde 200 igual para que Confío no reintente en bucle un evento que
    // nunca vamos a aceptar.
    //
    // Pero primero se AUTENTICA. No saber qué credencial espera un evento no lo
    // vuelve anónimo: se exige la del ramo one-shot, que acepta cualquiera de las
    // dos claves que ya conocemos, así que un llamador legítimo pasa igual que
    // antes. Hasta acá el `return` de abajo estaba por encima de esto y un
    // anónimo mandaba cualquier JSON con un `event` inventado, recibía 200 y
    // escribía un warn por request: le regalaba un oráculo de qué eventos
    // reconoce el sistema y una vía de ruido en el log (CWE-306).
    const ramo = classifyConfioWebhookEvent(payload.event)
    if (ramo === 'fuera_de_contrato') {
      this.autenticarRamoOneShot(rawBody, bearer)

      this.logger.warn(
        `Webhook ConfioPagos ignorado: evento fuera del contrato "${ecoDeLog(payload.event)}"`,
      )

      return { ignored: true }
    }

    if (ramo === 'firmado') this.autenticarRamoFirmado(payload, bearer)
    else this.autenticarRamoOneShot(rawBody, bearer)

    const eventType = payload?.event || 'unknown'
    // La clave identifica a la notificación, no al intento de entrega: la deriva
    // `buildConfioWebhookEventId` a partir de los campos que Confío reenvía igual.
    const providerEventId = buildConfioWebhookEventId(payload)

    return this.webhookService.receive('confio', eventType, providerEventId, payload)
  }

  /**
   * Parsea el cuerpo con veredicto propio: `null`, `[]` y `"x"` son JSON válido
   * pero no son un envelope, y sin este chequeo caerían con `event: undefined`
   * en el camino de 200 ignorado en vez de rechazarse.
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
   * Ramo FIRMADO (los dos eventos de suscripción): bearer + checksum.
   *
   * La política de "sin clave configurada" es DE ESTE RAMO, no del endpoint:
   * los eventos one-shot nunca traen `signature` y hoy se autentican con el
   * access token, así que aplicarles esta compuerta apagaría cobros vivos.
   *
   * Sin clave se rechaza EN TODOS LOS AMBIENTES, no sólo en producción. Antes
   * fallaba abierto fuera de producción, y eso dejó de ser inocuo cuando
   * `subscription.subscriptionStatusChanged` pasó a tener efecto CROSS-SERVICE:
   * un `status: CANCELED` sin autenticar ya no mueve nada más que una columna
   * local, ahora revoca el plan de la marca en backend-roles y la baja a `free`.
   * Un default que falla abierto no puede gobernar un efecto irreversible sobre
   * los permisos de otro servicio, aunque sea en dev.
   *
   * Precio: dev y staging necesitan `CONFIO_WEBHOOK_KEY` sembrada en Infisical
   * para poder recibir estos dos eventos (registrado en HUMAN_ACTIONS).
   */
  private autenticarRamoFirmado(payload: ConfioWebhookPayload, bearer: string): void {
    if (!this.webhookKey) {
      this.logger.error(
        `Webhook ConfioPagos rechazado: reason=missing_key ${SIN_CAMPOS_DE_FIRMA} ` +
          'detail=CONFIO_WEBHOOK_KEY vacía o CHANGEME',
      )
      throw new HttpException('Webhook de ConfioPagos rechazado', HttpStatus.UNAUTHORIZED)
    }

    // El bearer se compara ANTES del checksum: es la comprobación barata, y va
    // en tiempo constante con la misma primitiva que usa el digest.
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
   * Ramo ONE-SHOT (link de pago): tráfico VIVO que llega sin `signature`.
   *
   * Se aceptan LOS DOS bearer —el access token de hoy y la clave de webhook—
   * porque no está confirmado con Confío cuál mandan estos eventos una vez
   * registrada la URL, y provisionar la clave no puede apagar cobros en vuelo.
   */
  private autenticarRamoOneShot(rawBody: Buffer, bearer: string): void {
    const conAccessToken = this.confioProvider.validateWebhookSignature(rawBody, bearer)
    const conClaveDeWebhook =
      !!this.webhookKey && timingSafeEqualStrings(bearer, this.webhookKey)

    if (!conAccessToken && !conClaveDeWebhook) {
      throw this.rechazarWebhookConfio(
        'bearer_mismatch',
        SIN_CAMPOS_DE_FIRMA,
        'el Authorization no coincide ni con CONFIO_ACCESS_TOKEN ni con CONFIO_WEBHOOK_KEY',
      )
    }
  }

  /** Rechazo de webhook de ConfioPagos: UNA línea de log y un 401. */
  private rechazarWebhookConfio(reason: string, campos: string, detail: string): HttpException {
    this.logger.warn(
      `Webhook ConfioPagos rechazado: reason=${reason} ${campos} detail="${ecoDeLog(detail)}"`,
    )

    return new HttpException('Webhook de ConfioPagos rechazado', HttpStatus.UNAUTHORIZED)
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
