import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { WalletService } from './wallet.service'

@ApiTags('Wallet')
@Controller('wallet')
@UseGuards()
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Listar wallets de una marca' })
  @ApiResponse({ status: 200, description: 'Wallets obtenidas correctamente' })
  async findByBrand(@Query('brandId') brandId: string) {
    return this.walletService.findByBrand(brandId)
  }

  @Get('global-balance')
  @ApiOperation({ summary: 'Balance global de todas las wallets de una marca' })
  @ApiResponse({ status: 200, description: 'Balance global obtenido' })
  async getGlobalBalance(@Query('brandId') brandId: string) {
    return this.walletService.getGlobalBalance(brandId)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una wallet' })
  @ApiResponse({ status: 200, description: 'Wallet obtenida correctamente' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.findById(id)
  }

  @Post()
  @ApiOperation({ summary: 'Crear una wallet (máx 10 por marca)' })
  @ApiResponse({ status: 201, description: 'Wallet creada correctamente' })
  async create(@Body() data: any) {
    return this.walletService.create(data)
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'Historial de transacciones de una wallet' })
  @ApiResponse({ status: 200, description: 'Transacciones obtenidas correctamente' })
  async getTransactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() filters: { page?: number; limit?: number; type?: string },
  ) {
    return this.walletService.getTransactions(id, filters)
  }

  @Get(':id/balance')
  @ApiOperation({ summary: 'Balance actual de una wallet' })
  @ApiResponse({ status: 200, description: 'Balance obtenido correctamente' })
  async getBalance(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.walletService.findById(id)
    if (result.data) {
      return { data: { balance: result.data.balance, currency: result.data.currency } }
    }
    return result
  }

  // ============================================
  // Transferencias
  // ============================================

  @Post('transfer')
  @ApiOperation({ summary: 'Transferir fondos entre wallets (misma marca y moneda)' })
  @ApiResponse({ status: 200, description: 'Transferencia realizada' })
  async transfer(@Body() data: {
    fromWalletId: string
    toWalletId: string
    amount: number
    description?: string
  }) {
    return this.walletService.transfer(data)
  }

  // ============================================
  // Freeze / Close (Admin)
  // ============================================

  @Post(':id/freeze')
  @ApiOperation({ summary: 'Congelar wallet (bloquea débitos)' })
  @ApiResponse({ status: 200, description: 'Wallet congelada' })
  async freeze(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.freeze(id)
  }

  @Post(':id/unfreeze')
  @ApiOperation({ summary: 'Descongelar wallet' })
  @ApiResponse({ status: 200, description: 'Wallet descongelada' })
  async unfreeze(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.unfreeze(id)
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Cerrar wallet (requiere balance 0)' })
  @ApiResponse({ status: 200, description: 'Wallet cerrada' })
  async close(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.close(id)
  }
}
