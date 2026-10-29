import { Controller, Get, Post, Body, Query, Req, UseGuards, HttpStatus } from '@nestjs/common'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { CheckoutService, CheckoutRequest } from './checkout.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { RequestException } from '../shared/exception/request.exception'

/**
 * ⚠️ AUTENTICADO. Antes este controller declaraba `@UseGuards()` SIN argumento —un
 * decorador vacío, o sea ningún guard—, así que todo endpoint de acá era
 * alcanzable sin credencial por el gateway público: cualquiera podía originar
 * cobros y links de pago. Verificado en vivo el 2026-08-25 con 20+ POST sin
 * credencial, que dejaron filas en `payments` y `payment_attempts`.
 *
 * `ApiAuthGuard` resuelve quién llama con el MISMO JWT del resto del sistema
 * (cookie de sesión o Bearer, verificado local con `JWT_SECRET`, más el
 * `ACCESS_SERVER` para server-to-server y el fallback a
 * `POST /client/validate-token` de backend-auth para los tokens de auto-login,
 * firmados con un `clientSecret` que rota y que payments no puede guardar).
 */
@ApiTags('Checkout')
@Controller('checkout')
@UseGuards(ApiAuthGuard)
export class CheckoutController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly providerConfigService: ProviderConfigService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Procesar checkout completo (pago → suscripción → factura → DIAN → roles)',
  })
  @ApiResponse({ status: 201, description: 'Checkout procesado' })
  @ApiResponse({
    status: 400,
    description:
      'INVALID_BRAND_ID (brandId ausente o que no es un UUID), INVALID_PLAN_SLUG ' +
      '(planSlug ausente o inválido en la compra de plan) o MISSING_WALLET_ID ' +
      '(pago con wallet o recarga sin walletId)',
  })
  @ApiResponse({
    status: 403,
    description: 'forbidden: caller user session is not a member of the brand with a paying role',
  })
  @ApiResponse({
    status: 404,
    description:
      'BRAND_NOT_FOUND (platform no conoce la marca) o WALLET_NOT_FOUND ' +
      '(la wallet no existe o no es de esa marca)',
  })
  @ApiResponse({
    status: 409,
    description: 'IDEMPOTENCY_KEY_CONFLICT: Idempotency-Key reused with a different request body',
  })
  @ApiResponse({
    status: 422,
    description:
      'BRAND_WITHOUT_COUNTRY, PRICE_NOT_FOUND_FOR_COUNTRY o ' +
      'WALLET_CURRENCY_MISMATCH: no se puede determinar o cobrar el precio',
  })
  @ApiResponse({
    status: 503,
    description: 'BRAND_LOOKUP_UNAVAILABLE o PLAN_NOT_FOUND: platform o backend-roles no responden',
  })
  async processCheckout(@Body() body: CheckoutRequest, @Req() req?: any) {
    if (req?.user?.id !== 'server') {
      const allowed = await this.platformClient.canViewBrandCredit(req?.user?.id, body?.brandId)
      if (!allowed) {
        throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
      }
    }
    const idempotencyKey = this.extractIdempotencyKey(req)
    // `renewal` es service-to-service (sólo el cron). `CheckoutRequest` es una
    // interfaz, así que el `ValidationPipe({ whitelist, forbidNonWhitelisted })`
    // global no tiene metatype contra el cual recortar y NO descarta claves
    // desconocidas: sin este borrado un llamador HTTP podría pedir el camino de
    // precios legacy y cobrarse en la moneda que él mande.
    return {
      data: await this.checkoutService.processCheckout({
        ...body,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        renewal: undefined,
      }),
    }
  }

  private extractIdempotencyKey(req?: any): string | undefined {
    const headers = req?.headers
    if (!headers || typeof headers !== 'object') {
      return undefined
    }
    const raw =
      headers['idempotency-key'] ??
      headers['Idempotency-Key'] ??
      Object.entries(headers).find(([key]) => key.toLowerCase() === 'idempotency-key')?.[1]
    if (typeof raw !== 'string') {
      return undefined
    }
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  @Get('providers')
  @ApiOperation({ summary: 'Proveedores de pago disponibles para un país' })
  @ApiResponse({ status: 200, description: 'Lista de proveedores disponibles' })
  async getAvailableProviders(@Query('country') country: string) {
    const providers = await this.providerConfigService.getAvailableProviders(country || 'CO')
    return { data: providers }
  }

  @Get('return')
  @ApiOperation({
    summary: 'Reconciliar un pago al volver del checkout (consulta estado real del proveedor)',
  })
  @ApiResponse({ status: 200, description: 'Estado reconciliado del pago' })
  async paymentReturn(
    @Query('paymentId') paymentId?: string,
    @Query('correlation_id') correlationId?: string,
  ) {
    // ConfioPagos redirige con correlation_id = nuestro paymentId.
    return { data: await this.checkoutService.reconcilePayment(paymentId || correlationId) }
  }
}
