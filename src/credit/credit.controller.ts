import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import { RequestException } from '../shared/exception/request.exception'
import { ClientPlatformService } from '../client/client-platform.service'
import { CreditService } from './credit.service'
import { ScaleConfigService } from './scale-config.service'
import { CreditRunService } from './credit-run.service'
import { BureauService } from './bureau/bureau.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequirePermission } from '../shared/auth/require-permission.decorator'
import { CalculateScoreDto } from './dto/calculate-score.dto'
import { CreateRunDto } from './dto/create-run.dto'
import { RegisterProfileDto } from './dto/register-profile.dto'
import { GrantConsentDto } from './dto/grant-consent.dto'
import { CreateBureauCheckDto } from './dto/create-bureau-check.dto'
import { CreateScaleVersionDto } from './dto/create-scale-version.dto'
import { CreateActivationRequestDto } from './dto/create-activation-request.dto'

/**
 * Endpoints de scoring de crédito (Fase 2): cálculo individual, consulta por
 * marca y gestión de versiones de la escala. Los runs masivos son Fase 3; el
 * RBAC fino (activar escala, buró manual) es Fase 5. Ver §8 del diseño.
 */
@ApiTags('Credit')
@Controller('credit')
export class CreditController {
  constructor(
    private readonly creditService: CreditService,
    private readonly scaleConfigService: ScaleConfigService,
    private readonly creditRunService: CreditRunService,
    private readonly bureauService: BureauService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Post('scores/calculate')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Calcular el score de crédito de una marca para un período' })
  async calculate(@Body() body: CalculateScoreDto, @Req() req: any) {
    const score = await this.creditService.calculate({
      brandId: body.brandId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      triggeredBy: req?.user?.id ? `manual:${req.user.id}` : 'manual',
    })
    return { data: score }
  }

  @Get('scores')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Listar scores (ranking), filtrable por run' })
  async listScores(
    @Query('runId') runId?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    const p = Math.max(1, Number(page) || 1)
    const ps = Math.min(200, Math.max(1, Number(pageSize) || 50))
    const { data, total } = await this.creditService.listScores({ runId, page: p, pageSize: ps })
    return { data, total, page: p, pageSize: ps }
  }

  @Get('preapproval/:brandId')
  @UseGuards(ApiAuthGuard)
  @ApiOperation({ summary: 'Pre-aprobado de crédito (informativo, curado para el cliente)' })
  async preapproval(@Param('brandId') brandId: string, @Req() req: any) {
    // Brand- y role-scope (defense-in-depth además del BFF): salvo el server/
    // superadmin, el usuario debe ser miembro de la marca con rol owner/admin/
    // financiero. La causa del 403 no distingue para no filtrar existencia.
    if (!req?.user?.isSuperAdmin) {
      const allowed = await this.platformClient.canViewBrandCredit(req?.user?.id, brandId)
      if (!allowed) {
        throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
      }
    }
    return { data: await this.creditService.getPreapproval(brandId) }
  }

  @Post('activation-requests')
  @UseGuards(ApiAuthGuard)
  @ApiOperation({ summary: 'Crear una solicitud de activación de crédito para una marca elegible' })
  async createActivationRequest(@Body() body: CreateActivationRequestDto, @Req() req: any) {
    const brandId = req?.user?.brand
    if (!brandId) {
      throw new RequestException({ error: 'brandRequired', code: 'brandRequired' }, HttpStatus.BAD_REQUEST)
    }
    return {
      data: await this.creditService.createActivationRequest(brandId, body, req?.user?.id || null),
    }
  }

  @Get('scores/brand/:brandId')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Último score (o historial) de una marca' })
  async getByBrand(
    @Param('brandId') brandId: string,
    @Query('latest') latest?: string,
  ) {
    const data = await this.creditService.getByBrand(brandId, latest !== 'false')
    return { data }
  }

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Disparar un run masivo de scoring para un período' })
  async createRun(@Body() body: CreateRunDto, @Req() req: any) {
    const run = await this.creditRunService.createRun({
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      triggeredBy: req?.user?.id ? `manual:${req.user.id}` : 'manual',
    })
    return { data: run }
  }

  @Get('runs')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Listar runs recientes' })
  async listRuns() {
    return { data: await this.creditRunService.listRuns() }
  }

  @Get('runs/:id')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Progreso/estado de un run' })
  async getRun(@Param('id') id: string) {
    return { data: await this.creditRunService.getRun(id) }
  }

  // --- Buró / perfil (Fase 5) ---

  @Get('profile/:brandId')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:bureau')
  @ApiOperation({ summary: 'Perfil de crédito de una marca (documento + consentimiento)' })
  async getProfile(@Param('brandId') brandId: string) {
    return { data: await this.bureauService.getProfile(brandId) }
  }

  @Post('profile/:brandId')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:bureau')
  @ApiOperation({ summary: 'Registrar/actualizar el documento legal del perfil' })
  async registerProfile(@Param('brandId') brandId: string, @Body() body: RegisterProfileDto) {
    return { data: await this.bureauService.upsertProfile(brandId, body) }
  }

  @Post('profile/:brandId/consent')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:bureau')
  @ApiOperation({ summary: 'Registrar consentimiento habeas data del titular' })
  async grantConsent(
    @Param('brandId') brandId: string,
    @Body() body: GrantConsentDto,
    @Req() req: any,
  ) {
    const by = req?.user?.id || 'admin'
    return { data: await this.bureauService.grantConsent(brandId, body, by) }
  }

  @Get('bureau/checks/brand/:brandId')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:bureau')
  @ApiOperation({ summary: 'Historial de checks de buró de una marca' })
  async bureauChecks(@Param('brandId') brandId: string) {
    return { data: await this.bureauService.getChecksByBrand(brandId) }
  }

  @Post('bureau/checks')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:bureau')
  @ApiOperation({ summary: 'Cargar un check de buró (manual). Requiere permiso credit:bureau' })
  async createBureauCheck(@Body() body: CreateBureauCheckDto, @Req() req: any) {
    const by = req?.user?.id || 'admin'
    const { brandId, ...rest } = body
    return { data: await this.bureauService.createManualCheck(brandId, rest, by) }
  }

  @Get('config/scales')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:scale')
  @ApiOperation({ summary: 'Versión de escala activa' })
  async activeScale() {
    return { data: await this.scaleConfigService.getActiveConfig() }
  }

  @Get('config/scales/versions')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:scale')
  @ApiOperation({ summary: 'Listar versiones de escala' })
  async listScaleVersions() {
    return { data: await this.scaleConfigService.listVersions() }
  }

  @Post('config/scales')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:scale')
  @ApiOperation({ summary: 'Crear una versión nueva de escala (pesos/valores editados)' })
  async createScaleVersion(@Body() body: CreateScaleVersionDto, @Req() req: any) {
    const created = await this.scaleConfigService.createVersion(
      body.config,
      req?.user?.id || 'admin',
      !!body.activate,
    )
    return { data: { version: created.version, status: created.status } }
  }

  @Post('config/scales/:version/activate')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:scale')
  @ApiOperation({ summary: 'Activar una versión de escala (valida draft→active)' })
  async activateScale(@Param('version') version: string, @Req() req: any) {
    const activated = await this.scaleConfigService.activateVersion(
      Number(version),
      req?.user?.id || 'admin',
    )
    return { data: { version: activated.version, status: activated.status } }
  }
}
