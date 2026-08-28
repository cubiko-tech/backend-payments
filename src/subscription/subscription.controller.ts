import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { CreateSubscriptionDto } from './dto/create-subscription.dto'

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
 *
 * Es autenticación SOLA: ningún handler de acá declara `@RequirePermission`, así
 * que no se agrega ninguna exigencia de permiso nueva. Deliberado — cerrar el
 * agujero no debe romperle el acceso a un cliente que hoy funciona; los permisos,
 * si hacen falta, son una decisión aparte.
 *
 * ⚠️ CONSECUENCIA ABIERTA: el `brandId` viaja en el query o en el body y NINGÚN
 * handler lo compara contra `req.user.brand`, que `ApiAuthGuard` ya resolvió. O
 * sea que un usuario autenticado puede leer, cambiar de plan o dar de baja la
 * suscripción de CUALQUIER marca. Es deuda conocida y anotada en el INBOX de
 * roax-ops (autorización por marca en `subscription.controller`); no se cierra acá
 * porque exige decidir qué pasa con los llamadores server-to-server y con los
 * superadmins. Lo que SÍ se cerró es lo que esa lectura habilitaba: el alta
 * genérica ya no acepta campos arbitrarios (ver `create` más abajo).
 */
@ApiTags('Subscription')
@Controller('subscription')
@UseGuards(ApiAuthGuard)
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly enterprisePricingService: EnterprisePricingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtener suscripción actual de una marca' })
  @ApiResponse({ status: 200, description: 'Suscripción obtenida correctamente' })
  async getCurrent(@Query('brandId') brandId: string) {
    return this.subscriptionService.getCurrent(brandId)
  }

  /**
   * Re-pide el link de aceptación a ConfioPagos en vez de devolver uno guardado.
   *
   * El `acceptanceUrl` es un link PORTADOR —quien lo tenga registra una tarjeta—
   * y por eso NO se persiste: lo que se guarda es el `name` del recurso, y el
   * link se pide de nuevo por acá, detrás del guard. Confío sólo lo entrega
   * mientras la suscripción está en `PENDING_ACCEPTANCE`; después no hay link
   * que dar y el servicio lo dice con su propio código.
   */
  @Get('acceptance-link')
  @ApiOperation({ summary: 'Obtener el link de aceptación vigente de una marca' })
  @ApiResponse({ status: 200, description: 'Link de aceptación obtenido' })
  @ApiResponse({ status: 404, description: 'SUBSCRIPTION_NOT_FOUND' })
  async getAcceptanceLink(@Query('brandId') brandId: string) {
    return this.subscriptionService.getAcceptanceLink(brandId)
  }

  /**
   * ⚠️ El body va TIPADO y no es opcional: `SubscriptionService.create` guarda lo
   * que reciba (`repository.create(data)` + `save(data)`), así que el DTO ES el
   * control de acceso a las columnas. Con `@Body() data: any` no hay metatype y el
   * `ValidationPipe` global no filtra nada: se podía mandar el `id` de la fila de
   * otra marca —que el `GET` de arriba entrega— y convertir el `save` en un UPDATE
   * ajeno, o mandar `trialStart: null` para que `POST /subscription/trial` regale
   * una segunda prueba. El porqué de cada campo, en `dto/create-subscription.dto.ts`.
   *
   * Las fechas viajan ISO y se convierten acá, como en `upsertEnterprisePricing`:
   * el pipe global corre sin `transform`, así que del body salen strings.
   */
  @Post()
  @ApiOperation({ summary: 'Crear una suscripción' })
  @ApiResponse({ status: 201, description: 'Suscripción creada correctamente' })
  @ApiResponse({ status: 400, description: 'Campo no permitido en el body' })
  async create(@Body() data: CreateSubscriptionDto) {
    return this.subscriptionService.create({
      ...data,
      currentPeriodStart: data.currentPeriodStart ? new Date(data.currentPeriodStart) : undefined,
      currentPeriodEnd: data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : undefined,
      nextBillingDate: data.nextBillingDate ? new Date(data.nextBillingDate) : undefined,
    })
  }

  @Post('trial')
  @ApiOperation({ summary: 'Iniciar trial gratuito de 15 días (sin método de pago)' })
  @ApiResponse({ status: 201, description: 'Trial iniciado correctamente' })
  async startTrial(
    @Body() data: { brandId: string; userId: string; planSlug: string; provider?: any; walletId?: string },
  ) {
    return this.subscriptionService.startTrial(data)
  }

  @Patch('plan')
  @ApiOperation({ summary: 'Cambiar de plan' })
  @ApiResponse({ status: 200, description: 'Plan cambiado correctamente' })
  async changePlan(@Body() data: { brandId: string; planSlug: string; triggeredBy: string }) {
    return this.subscriptionService.changePlan(data.brandId, {
      planSlug: data.planSlug,
      triggeredBy: data.triggeredBy,
    })
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Cancelar suscripción' })
  @ApiResponse({ status: 200, description: 'Suscripción cancelada correctamente' })
  async cancel(@Body() data: { brandId: string; reason: string; triggeredBy: string }) {
    return this.subscriptionService.cancel(data.brandId, {
      reason: data.reason,
      triggeredBy: data.triggeredBy,
    })
  }

  @Post('reactivate')
  @ApiOperation({ summary: 'Reactivar suscripción cancelada' })
  @ApiResponse({ status: 200, description: 'Suscripción reactivada correctamente' })
  async reactivate(@Body() data: { brandId: string; triggeredBy: string }) {
    return this.subscriptionService.reactivate(data.brandId, data.triggeredBy)
  }

  @Get('history')
  @ApiOperation({ summary: 'Historial de eventos de suscripción' })
  @ApiResponse({ status: 200, description: 'Historial obtenido correctamente' })
  async getHistory(@Query('brandId') brandId: string) {
    return this.subscriptionService.getHistory(brandId)
  }

  // ============================================
  // Enterprise Pricing (Admin)
  // ============================================

  @Get('enterprise-pricing')
  @ApiOperation({ summary: 'Listar precios enterprise personalizados (Admin)' })
  @ApiResponse({ status: 200, description: 'Lista de precios enterprise' })
  async listEnterprisePricing() {
    return this.enterprisePricingService.findAll()
  }

  @Get('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Obtener precio enterprise de una marca (Admin)' })
  @ApiResponse({ status: 200, description: 'Precio enterprise obtenido' })
  async getEnterprisePricing(@Param('brandId') brandId: string) {
    const pricing = await this.enterprisePricingService.getForBrand(brandId)
    return { data: pricing }
  }

  @Post('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Crear/actualizar precio enterprise para marca (Admin)' })
  @ApiResponse({ status: 201, description: 'Precio enterprise guardado' })
  async upsertEnterprisePricing(
    @Param('brandId') brandId: string,
    @Body() data: {
      monthlyPrice: number
      currency?: string
      negotiatedBy?: string
      validUntil?: string
      notes?: string
    },
  ) {
    return this.enterprisePricingService.upsert(brandId, {
      ...data,
      validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
    })
  }

  @Delete('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Eliminar precio enterprise (volver a estándar) (Admin)' })
  @ApiResponse({ status: 200, description: 'Precio enterprise eliminado' })
  async removeEnterprisePricing(@Param('brandId') brandId: string) {
    return this.enterprisePricingService.remove(brandId)
  }
}
