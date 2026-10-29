import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import { assertResourceBrandAccess, isPrivilegedCaller } from '../shared/auth/brand-scope.util'
import { RequestException } from '../shared/exception/request.exception'
import { ClientPlatformService } from '../client/client-platform.service'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { CreateSubscriptionDto } from './dto/create-subscription.dto'
import { StartPaidSubscriptionDto } from './dto/start-paid-subscription.dto'

/**
 * Authenticated subscription endpoints guarded by `ApiAuthGuard` (session cookie or Bearer
 * JWT, `ACCESS_SERVER` for server-to-server calls, and `POST /client/validate-token` fallback
 * for auto-login tokens signed with rotating client secrets).
 *
 * Authorization coverage:
 * - `GET /subscription/enterprise-pricing`, `POST /subscription/enterprise-pricing/:brandId`,
 *   and `DELETE /subscription/enterprise-pricing/:brandId` require `@RequireSuperAdmin()`.
 * - `GET /subscription/enterprise-pricing/:brandId` requires brand membership
 *   (`assertResourceBrandAccess`) or an operator.
 * - `GET /subscription`, `/acceptance-link`, `/history`, and `POST /confirm` resolve the
 *   caller brand via `resolveBrandId` (session brand when present so query mismatches do
 *   not act as a brand-existence oracle).
 * - `POST /subscription/trial`, `PATCH /subscription/plan`, `POST /subscription/cancel`,
 *   and `POST /subscription/reactivate` resolve the target brand via `resolveBrandId`
 *   (session brand or body `brandId` verified via `ClientPlatformService.canViewBrandCredit`;
 *   only privileged service principals can target any brand).
 */
@ApiTags('Subscription')
@Controller('subscription')
@UseGuards(ApiAuthGuard)
export class SubscriptionController {
  private readonly logger = new Logger(SubscriptionController.name)

  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly enterprisePricingService: EnterprisePricingService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtener suscripción actual de una marca' })
  @ApiResponse({ status: 200, description: 'Suscripción obtenida correctamente' })
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  async getCurrent(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.getCurrent(await this.resolveBrandId(brandId, req))
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
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  @ApiResponse({ status: 404, description: 'SUBSCRIPTION_NOT_FOUND' })
  async getAcceptanceLink(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.getAcceptanceLink(await this.resolveBrandId(brandId, req))
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
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (service principal without brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (caller is not a member of brandId)' })
  async startTrial(
    @Body()
    data: {
      brandId: string
      userId: string
      planSlug: string
      provider?: any
      walletId?: string
      /** Teléfono de la cuenta de ConfioPagos que va a pagar, si no es el del perfil. */
      billingPhone?: string
    },
    @Req() req?: any,
  ) {
    const brandId = await this.resolveBrandId(data?.brandId, req, true)
    return this.subscriptionService.startTrial({ ...data, brandId })
  }

  /**
   * Alta PAGA, sin prueba: para la marca que ya consumió su trial y quiere volver.
   *
   * Devuelve el `acceptanceUrl` en el TOPE de la respuesta —igual que `/trial`— y NUNCA
   * dentro de `data`: es un link PORTADOR y `data` es la fila, que se serializa entera.
   */
  @Post('paid')
  @ApiOperation({ summary: 'Alta de suscripción paga (sin prueba) contra ConfioPagos' })
  @ApiResponse({
    status: 201,
    description: 'Suscripción creada en `pending` con su link de aceptación',
  })
  @ApiResponse({
    status: 409,
    description: 'SUBSCRIPTION_ALREADY_EXISTS (la marca ya tiene servicio vigente)',
  })
  @ApiResponse({
    status: 422,
    description: 'INVALID_PAID_PLAN, CONFIO_PLAN_NOT_MAPPED, o contacto de comprador incompleto',
  })
  @ApiResponse({
    status: 503,
    description: 'PAID_START_FAILED (ConfioPagos no respondió o falló la escritura)',
  })
  async startPaid(@Body() data: StartPaidSubscriptionDto) {
    return this.subscriptionService.startPaid(data)
  }

  @Patch('plan')
  @ApiOperation({ summary: 'Cambiar de plan' })
  @ApiResponse({ status: 200, description: 'Plan cambiado correctamente' })
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (service principal without brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (caller is not a member of brandId)' })
  async changePlan(
    @Body() data: { brandId: string; planSlug: string; triggeredBy: string },
    @Req() req?: any,
  ) {
    const brandId = await this.resolveBrandId(data?.brandId, req, true)
    return this.subscriptionService.changePlan(brandId, {
      planSlug: data.planSlug,
      triggeredBy: data.triggeredBy,
    })
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Cancelar suscripción' })
  @ApiResponse({ status: 200, description: 'Suscripción cancelada correctamente' })
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (service principal without brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (caller is not a member of brandId)' })
  async cancel(
    @Body() data: { brandId: string; reason: string; triggeredBy: string },
    @Req() req?: any,
  ) {
    const brandId = await this.resolveBrandId(data?.brandId, req, true)
    return this.subscriptionService.cancel(brandId, {
      reason: data.reason,
      triggeredBy: data.triggeredBy,
    })
  }

  @Post('reactivate')
  @ApiOperation({ summary: 'Reactivar suscripción cancelada' })
  @ApiResponse({ status: 200, description: 'Suscripción reactivada correctamente' })
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (service principal without brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (caller is not a member of brandId)' })
  async reactivate(@Body() data: { brandId: string; triggeredBy: string }, @Req() req?: any) {
    const brandId = await this.resolveBrandId(data?.brandId, req, true)
    return this.subscriptionService.reactivate(brandId, data.triggeredBy)
  }

  /**
   * Confirma la suscripción preguntándole a ConfioPagos, sin esperar su webhook.
   *
   * Resuelve la marca del principal con la misma regla que las otras lecturas
   * (`resolveBrandId`, al final de la clase): un usuario confirma SU marca y sólo un
   * principal de servicio puede nombrar una ajena. Es `POST` porque escribe —puede
   * dejar la fila viva y asignar el plan en roles—, aunque el hecho lo decida el
   * proveedor y no el llamador.
   */
  @Post('confirm')
  @ApiOperation({ summary: 'Confirmar la suscripción contra ConfioPagos, sin esperar el webhook' })
  @ApiResponse({
    status: 201,
    description: 'Estado consultado; `confirmed` dice si ya quedó activa',
  })
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  @ApiResponse({ status: 404, description: 'SUBSCRIPTION_NOT_FOUND' })
  @ApiResponse({ status: 422, description: 'NO_CONFIO_SUBSCRIPTION' })
  @ApiResponse({ status: 503, description: 'CONFIO_STATUS_UNAVAILABLE (no se pudo preguntar)' })
  async confirm(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.confirm(await this.resolveBrandId(brandId, req))
  }

  @Get('history')
  @ApiOperation({ summary: 'Historial de eventos de suscripción' })
  @ApiResponse({ status: 200, description: 'Historial obtenido correctamente' })
  @ApiResponse({
    status: 400,
    description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)',
  })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  async getHistory(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.getHistory(await this.resolveBrandId(brandId, req))
  }

  @Get('enterprise-pricing')
  @RequireSuperAdmin()
  @ApiOperation({ summary: 'Listar precios enterprise personalizados (Admin)' })
  @ApiResponse({ status: 200, description: 'Lista de precios enterprise' })
  @ApiResponse({ status: 403, description: 'forbidden (operator required)' })
  async listEnterprisePricing() {
    return this.enterprisePricingService.findAll()
  }

  @Get('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Get enterprise pricing for a brand (member or operator)' })
  @ApiResponse({ status: 200, description: 'Precio enterprise obtenido' })
  @ApiResponse({ status: 403, description: 'forbidden (not a brand member or operator)' })
  async getEnterprisePricing(@Param('brandId') brandId: string, @Req() req?: any) {
    await assertResourceBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /subscription/enterprise-pricing/:brandId',
    )
    const pricing = await this.enterprisePricingService.getForBrand(brandId)
    return { data: pricing }
  }

  @Post('enterprise-pricing/:brandId')
  @RequireSuperAdmin()
  @ApiOperation({ summary: 'Crear/actualizar precio enterprise para marca (Admin)' })
  @ApiResponse({ status: 201, description: 'Precio enterprise guardado' })
  @ApiResponse({ status: 403, description: 'forbidden (operator required)' })
  async upsertEnterprisePricing(
    @Param('brandId') brandId: string,
    @Body()
    data: {
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
  @RequireSuperAdmin()
  @ApiOperation({ summary: 'Eliminar precio enterprise (volver a estándar) (Admin)' })
  @ApiResponse({ status: 200, description: 'Precio enterprise eliminado' })
  @ApiResponse({ status: 403, description: 'forbidden (operator required)' })
  async removeEnterprisePricing(@Param('brandId') brandId: string) {
    return this.enterprisePricingService.remove(brandId)
  }

  private async resolveBrandId(brandId: string, req: any, fromBody = false): Promise<string> {
    if (isPrivilegedCaller(req)) {
      if (!brandId) {
        throw new RequestException(
          {
            code: 'BRAND_ID_REQUIRED',
            message: 'brandId es obligatorio para un principal de servicio',
          },
          HttpStatus.BAD_REQUEST,
        )
      }
      return brandId
    }

    const rawSessionBrand = req?.user?.brand
    const sessionBrand =
      typeof rawSessionBrand === 'string'
        ? rawSessionBrand
        : typeof rawSessionBrand?.id === 'string'
          ? rawSessionBrand.id
          : undefined

    if (!fromBody && sessionBrand) {
      return sessionBrand
    }

    if (brandId) {
      if (sessionBrand && brandId === sessionBrand) {
        return sessionBrand
      }
      if (req?.user?.id && (await this.platformClient.canViewBrandCredit(req.user.id, brandId))) {
        return brandId
      }
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
    }

    if (sessionBrand) {
      return sessionBrand
    }

    throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
  }
}
