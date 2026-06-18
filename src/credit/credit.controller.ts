import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import { RequestException } from '../shared/exception/request.exception'
import { CreditService } from './credit.service'
import { ScaleConfigService } from './scale-config.service'
import { CalculateScoreDto } from './dto/calculate-score.dto'

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
  ) {}

  @Post('scores/calculate')
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

  @Get('scores/brand/:brandId')
  @ApiOperation({ summary: 'Último score (o historial) de una marca' })
  async getByBrand(
    @Param('brandId') brandId: string,
    @Query('latest') latest?: string,
  ) {
    const data = await this.creditService.getByBrand(brandId, latest !== 'false')
    return { data }
  }

  @Get('config/scales')
  @ApiOperation({ summary: 'Versión de escala activa' })
  async activeScale() {
    return { data: await this.scaleConfigService.getActiveConfig() }
  }

  @Post('config/scales/:version/activate')
  @ApiOperation({ summary: 'Activar una versión de escala (valida draft→active)' })
  async activateScale(@Param('version') version: string, @Req() req: any) {
    // RBAC fino en Fase 5; interino: solo superadmin puede cambiar la política.
    if (!req?.user?.isSuperAdmin) {
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
    }
    const activated = await this.scaleConfigService.activateVersion(
      Number(version),
      req?.user?.id || 'admin',
    )
    return { data: { version: activated.version, status: activated.status } }
  }
}
