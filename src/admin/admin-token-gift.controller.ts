import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuditService } from '../audit/audit.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSessionUser, RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import { TokenGiftBatchService } from '../wallet/token-gift-batch.service'
import { recordTokenGiftNotice } from '../wallet/token-gift-notice'
import { TokenOrigin } from '../wallet/token-origin'
import { fail, TokenWalletService } from '../wallet/token-wallet.service'
import { adminIdempotencyKey } from './admin-idempotency-key'
import {
  CreateGiftBatchDto,
  GetGiftBatchQueryDto,
  PreviewGiftBatchDto,
} from './dto/admin-token-gift-batch.dto'
import { DebitGiftTokensDto, GiftTokensDto } from './dto/admin-token-gift.dto'

/**
 * Gift tokens a super admin gives or removes on a brand: origin `gift`, with reason and author, no
 * invoice. The audit row commits with the movement, so neither is ever left unaudited.
 */
@ApiTags('Admin')
@Controller('admin/token-wallets')
@UseGuards(ApiAuthGuard)
@RequireSuperAdmin()
@RequireSessionUser()
export class AdminTokenGiftController {
  constructor(
    private readonly tokenWallets: TokenWalletService,
    private readonly auditService: AuditService,
    // Optional so single-brand specs that instantiate this controller with two args keep working.
    @Optional()
    private readonly giftBatches?: TokenGiftBatchService,
  ) {}

  @Post('gift-batches/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Preview brand count and total tokens for a gift batch (Admin)' })
  @ApiResponse({ status: 200, description: 'Matching brand count and total tokens' })
  @ApiResponse({ status: 400, description: 'Invalid filter or amount over the per-brand cap' })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  async previewGiftBatch(@Body() body: PreviewGiftBatchDto) {
    const preview = await this.giftBatches!.preview(body)
    return { data: preview }
  }

  @Post('gift-batches')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Create and enqueue a token gift batch operation (Admin)' })
  @ApiResponse({ status: 202, description: 'Batch accepted, or the existing one under this key' })
  @ApiResponse({ status: 400, description: 'Invalid filter, amount, reason, or idempotency key' })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  @ApiResponse({ status: 409, description: 'Total changed since preview or idempotency conflict' })
  async createGiftBatch(@Body() body: CreateGiftBatchDto, @Req() req: { user: { id: string } }) {
    const batch = await this.giftBatches!.create(body, req.user.id)
    return { data: batch }
  }

  @Get('gift-batches/:id')
  @ApiOperation({ summary: 'Get the status, counts, and omitted brands of a gift batch (Admin)' })
  @ApiResponse({ status: 200, description: 'Gift batch report with paginated omitted brands' })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  @ApiResponse({ status: 404, description: 'GIFT_BATCH_NOT_FOUND: batch does not exist' })
  async getGiftBatch(@Param('id', ParseUUIDPipe) id: string, @Query() query: GetGiftBatchQueryDto) {
    const report = await this.giftBatches!.getReport(id, query)
    return { data: report }
  }

  @Post(':brandId/gifts')
  @ApiOperation({ summary: 'Give gift tokens to a brand, once per idempotency key (Admin)' })
  @ApiResponse({ status: 201, description: 'Gift credited, or the first one under this key' })
  @ApiResponse({ status: 400, description: 'Missing reason or key, or amount not positive' })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  @ApiResponse({ status: 409, description: 'IDEMPOTENCY_KEY_CONFLICT: key used for another move' })
  @ApiResponse({ status: 422, description: 'WALLET_CLOSED: the token wallet is closed' })
  async gift(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() body: GiftTokensDto,
    @Req() req: { user: { id: string } },
  ) {
    const authorId: string = req.user.id
    const reason = body.reason.trim()
    const wallet = await this.tokenWallets.getOrCreate(brandId, brandId)
    const movement = await this.tokenWallets.creditTokens(
      wallet.id,
      body.amount,
      TokenOrigin.GIFT,
      {
        brandId,
        category: 'gift',
        description: reason,
        referenceType: 'admin',
        referenceId: authorId,
        metadata: { authorId, reason },
      },
      adminIdempotencyKey(body.idempotencyKey),
      async (manager, transaction) => {
        await this.auditService.record(manager, {
          userId: authorId,
          action: 'token_gift',
          entityType: 'wallet',
          entityId: wallet.id,
          changes: { brandId, amount: body.amount, reason, transactionId: transaction.id },
          description: `Gift of ${body.amount} tokens: ${reason}`,
        })
        await recordTokenGiftNotice(manager, {
          brandId,
          amount: body.amount,
          balanceAfter: Number(transaction.balanceAfter),
          movementKey: transaction.idempotencyKey!,
        })
      },
    )
    return { data: movement }
  }

  @Post(':brandId/gift-debits')
  @ApiOperation({ summary: 'Remove gift tokens from a brand, once per idempotency key (Admin)' })
  @ApiResponse({ status: 201, description: 'Gift debited, or the first one under this key' })
  @ApiResponse({ status: 400, description: 'Missing reason/key, or INSUFFICIENT_GIFT_TOKENS' })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND: the brand has no token wallet' })
  @ApiResponse({ status: 409, description: 'IDEMPOTENCY_KEY_CONFLICT: key used for another move' })
  @ApiResponse({ status: 422, description: 'WALLET_CLOSED: the token wallet is closed' })
  async debitGift(
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() body: DebitGiftTokensDto,
    @Req() req: { user: { id: string } },
  ) {
    const authorId: string = req.user.id
    const reason = body.reason.trim()
    const walletId = await this.tokenWallets.findTokenWalletId(brandId)
    if (!walletId) {
      throw fail('WALLET_NOT_FOUND', 'Wallet not found for this brand', HttpStatus.NOT_FOUND)
    }
    const movement = await this.tokenWallets.debitGiftTokens(
      walletId,
      body.amount,
      {
        brandId,
        category: 'gift_debit',
        description: reason,
        referenceType: 'admin',
        referenceId: authorId,
        metadata: { authorId, reason },
      },
      adminIdempotencyKey(body.idempotencyKey),
      async (manager, transaction) => {
        await this.auditService.record(manager, {
          userId: authorId,
          action: 'token_gift_debit',
          entityType: 'wallet',
          entityId: walletId,
          changes: { brandId, amount: body.amount, reason, transactionId: transaction.id },
          description: `Gift debit of ${body.amount} tokens: ${reason}`,
        })
        await recordTokenGiftNotice(manager, {
          brandId,
          amount: -body.amount,
          balanceAfter: Number(transaction.balanceAfter),
          movementKey: transaction.idempotencyKey!,
        })
      },
    )
    return { data: movement }
  }
}
