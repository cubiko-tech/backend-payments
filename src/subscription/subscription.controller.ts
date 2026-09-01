import {
  Controller,
  Get,
  HttpStatus,
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
import { RequestException } from '../shared/exception/request.exception'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { CreateSubscriptionDto } from './dto/create-subscription.dto'
import { StartPaidSubscriptionDto } from './dto/start-paid-subscription.dto'

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
 * ⚠️ CONSECUENCIA ABIERTA, YA NO ENTERA: las tres LECTURAS (`GET /subscription`,
 * `/acceptance-link` y `/history`) sí resuelven la marca contra `req.user` — la
 * regla completa está en `resolveBrandId`, al final de la clase. Lo que sigue
 * abierto son las ESCRITURAS: `create`, `startTrial`, `changePlan`, `cancel` y
 * `reactivate` toman el `brandId` del BODY y NINGUNA lo compara contra
 * `req.user.brand`, así que un usuario autenticado todavía puede cambiar de plan o
 * dar de baja la suscripción de CUALQUIER marca. Es deuda conocida y anotada en el
 * INBOX de roax-ops (autorización por marca en `subscription.controller`); queda
 * deliberadamente fuera de esta tarea porque un body es un contrato con más
 * llamadores que un query y exige decidir qué pasa con cada uno. Lo que SÍ se cerró
 * antes es lo que esa lectura habilitaba: el alta genérica ya no acepta campos
 * arbitrarios (ver `create` más abajo).
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
  @ApiResponse({ status: 400, description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)' })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  async getCurrent(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.getCurrent(this.resolveBrandId(brandId, req))
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
  @ApiResponse({ status: 400, description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)' })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  @ApiResponse({ status: 404, description: 'SUBSCRIPTION_NOT_FOUND' })
  async getAcceptanceLink(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.getAcceptanceLink(this.resolveBrandId(brandId, req))
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

  /**
   * Alta PAGA, sin prueba: para la marca que ya consumió su trial y quiere volver.
   *
   * Devuelve el `acceptanceUrl` en el TOPE de la respuesta —igual que `/trial`— y NUNCA
   * dentro de `data`: es un link PORTADOR y `data` es la fila, que se serializa entera.
   */
  @Post('paid')
  @ApiOperation({ summary: 'Alta de suscripción paga (sin prueba) contra ConfioPagos' })
  @ApiResponse({ status: 201, description: 'Suscripción creada en `pending` con su link de aceptación' })
  @ApiResponse({ status: 409, description: 'SUBSCRIPTION_ALREADY_EXISTS (la marca ya tiene servicio vigente)' })
  @ApiResponse({
    status: 422,
    description: 'INVALID_PAID_PLAN, CONFIO_PLAN_NOT_MAPPED, o contacto de comprador incompleto',
  })
  @ApiResponse({ status: 503, description: 'PAID_START_FAILED (ConfioPagos no respondió o falló la escritura)' })
  async startPaid(@Body() data: StartPaidSubscriptionDto) {
    return this.subscriptionService.startPaid(data)
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
  @ApiResponse({ status: 400, description: 'BRAND_ID_REQUIRED (principal de servicio sin brandId)' })
  @ApiResponse({ status: 403, description: 'forbidden (usuario sin marca)' })
  async getHistory(@Query('brandId') brandId: string, @Req() req: any) {
    return this.subscriptionService.getHistory(this.resolveBrandId(brandId, req))
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

  /**
   * De qué marca es la lectura. Regla ÚNICA de las tres lecturas del controller,
   * escrita una sola vez para que no puedan divergir entre sí.
   *
   * - Principal de SERVICIO (`isSuperAdmin`): se honra el `brandId` del query tal
   *   cual. Es el único que puede nombrar una marca ajena, y tiene que poder: el
   *   `ACCESS_SERVER` llega como `{ id: 'server', isSuperAdmin: true, brand: null }`
   *   —no tiene marca propia—, así que sin el query no podría direccionar nada. Por
   *   eso mismo, si el query falta, es 400 y no un fallback silencioso a "ninguna".
   * - Principal USUARIO: se lee SU marca y el query se IGNORA, incluso si trae otra.
   *   Se ignora en vez de rechazar por dos razones. Una, un 400 ante el desacuerdo
   *   convertiría el endpoint en un oráculo de existencia de marcas —el mismo motivo
   *   por el que `credit.controller` no distingue la causa de su 403—. Dos, los
   *   llamadores de hoy mandan su propio `brandId` en el query y rechazarlos los
   *   rompería sin ganar nada: la propiedad que importa es que por ningún camino
   *   salga el dato de la marca del query, y ignorarla ya la cumple.
   * - Usuario SIN marca: 403 con el mismo `{ error: 'forbidden', code: 'forbidden' }`
   *   que usa el guard, para que el cliente no pueda distinguir "no tengo marca" de
   *   "no tengo permiso".
   *
   * El chequeo por falsy cubre a la vez el `brandId` ausente (`undefined`) y el
   * vacío (`?brandId=` llega como `''`), igual que `credit.controller.ts`.
   *
   * ⚠️ DEUDA RESIDUAL: `req.user.brand` es un CLAIM, no una verificación de
   * pertenencia. Sale del JWT local (`payload.brand`) o de lo que devuelve
   * backend-auth (`body.data.brand`), y acá no se contrasta contra backend-platform
   * como sí hace `credit.controller.preapproval` con `canViewBrandCredit`. Un token
   * con una marca vieja sigue leyendo esa marca; cerrarlo exige el mismo llamado
   * cross-servicio y es una decisión aparte.
   */
  private resolveBrandId(brandId: string, req: any): string {
    if (req?.user?.isSuperAdmin) {
      if (!brandId) {
        throw new RequestException(
          { code: 'BRAND_ID_REQUIRED', message: 'brandId es obligatorio para un principal de servicio' },
          HttpStatus.BAD_REQUEST,
        )
      }
      return brandId
    }

    const brand = req?.user?.brand
    if (!brand) {
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
    }
    return brand
  }
}
