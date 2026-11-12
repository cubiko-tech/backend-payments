import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { WalletService } from './wallet.service'
import { CreateWalletDto } from './dto/create-wallet.dto'
import { TransferWalletDto } from './dto/transfer-wallet.dto'
import { ListWalletTransactionsQueryDto } from './dto/list-wallet-transactions-query.dto'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSessionUser, RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import { ClientPlatformService } from '../client/client-platform.service'
import {
  assertBrandAccess,
  assertResourceBrandAccess,
  isPrivilegedCaller,
  resolveRequestBrandId,
} from '../shared/auth/brand-scope.util'

@ApiTags('Wallet')
@Controller('wallet')
/** Authenticates at the class boundary; brand ownership or super-admin checks stay per handler. */
@UseGuards(ApiAuthGuard)
export class WalletController {
  private readonly logger = new Logger(WalletController.name)

  constructor(
    private readonly walletService: WalletService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar wallets de una marca' })
  @ApiResponse({ status: 200, description: 'Wallets obtenidas correctamente' })
  async findByBrand(@Query('brandId') brandId: string, @Req() req?: any) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /wallet',
    )
    return this.walletService.findByBrand(validBrandId)
  }

  @Get('global-balance')
  @ApiOperation({ summary: 'Balance global de todas las wallets de una marca' })
  @ApiResponse({ status: 200, description: 'Balance global obtenido' })
  async getGlobalBalance(@Query('brandId') brandId: string, @Req() req?: any) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /wallet/global-balance',
    )
    return this.walletService.getGlobalBalance(validBrandId)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una wallet' })
  @ApiResponse({ status: 200, description: 'Wallet obtenida correctamente' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const result = await this.walletService.findById(id)
    await assertResourceBrandAccess(
      this.platformClient,
      this.logger,
      req,
      result?.data?.brandId,
      'GET /wallet/:id',
    )
    return result
  }

  @Post()
  @ApiOperation({ summary: 'Crear una wallet (máx 10 por marca)' })
  @ApiResponse({ status: 201, description: 'Wallet creada correctamente' })
  async create(
    @Body() data: CreateWalletDto,
    @Req() req?: any,
    @Query('brandId') brandId?: string,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      resolveRequestBrandId(req, brandId),
      'POST /wallet',
    )
    return this.walletService.create({
      ...data,
      userId: data.userId ?? req?.user?.id,
      brandId: validBrandId,
    })
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'Historial de transacciones de una wallet' })
  @ApiResponse({ status: 200, description: 'Transacciones obtenidas correctamente' })
  async getTransactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() filters: ListWalletTransactionsQueryDto,
    @Req() req?: any,
  ) {
    const privileged = isPrivilegedCaller(req)
    if (!privileged) {
      const wallet = await this.walletService.findById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        wallet?.data?.brandId,
        'GET /wallet/:id/transactions',
      )
      return this.walletService.getTransactions(id, filters, { redactForMember: true })
    }
    return this.walletService.getTransactions(id, filters)
  }

  @Get(':id/balance')
  @ApiOperation({ summary: 'Balance actual de una wallet' })
  @ApiResponse({ status: 200, description: 'Balance obtenido correctamente' })
  async getBalance(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const result = await this.walletService.findById(id)
    await assertResourceBrandAccess(
      this.platformClient,
      this.logger,
      req,
      result?.data?.brandId,
      'GET /wallet/:id/balance',
    )
    if (result.data) {
      return { data: { balance: result.data.balance, currency: result.data.currency } }
    }
    return result
  }

  @Post('transfer')
  @ApiOperation({ summary: 'Transferir fondos entre wallets (misma marca y moneda)' })
  @ApiResponse({ status: 200, description: 'Transferencia realizada' })
  async transfer(@Body() data: TransferWalletDto, @Req() req?: any) {
    if (!isPrivilegedCaller(req)) {
      const fromWallet = await this.walletService.findById(data?.fromWalletId)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        fromWallet?.data?.brandId,
        'POST /wallet/transfer',
      )
    }
    return this.walletService.transfer(data)
  }

  @Post(':id/freeze')
  @RequireSuperAdmin()
  @RequireSessionUser()
  @ApiOperation({ summary: 'Congelar wallet (bloquea débitos)' })
  @ApiResponse({ status: 200, description: 'Wallet congelada' })
  async freeze(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.freeze(id)
  }

  @Post(':id/unfreeze')
  @RequireSuperAdmin()
  @RequireSessionUser()
  @ApiOperation({ summary: 'Descongelar wallet' })
  @ApiResponse({ status: 200, description: 'Wallet descongelada' })
  async unfreeze(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.unfreeze(id)
  }

  @Post(':id/close')
  @RequireSuperAdmin()
  @RequireSessionUser()
  @ApiOperation({ summary: 'Cerrar wallet (requiere balance 0)' })
  @ApiResponse({ status: 200, description: 'Wallet cerrada' })
  async close(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.close(id)
  }
}
