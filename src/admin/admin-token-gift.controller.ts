import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuditService } from '../audit/audit.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSessionUser, RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import { TokenOrigin } from '../wallet/token-origin'
import { TokenWalletService } from '../wallet/token-wallet.service'
import { adminIdempotencyKey } from './admin-idempotency-key'
import { GiftTokensDto } from './dto/admin-token-gift.dto'

/**
 * Gift tokens a super admin gives a brand: origin `gift`, with reason and author, no invoice. The
 * `token_gift` audit row commits with the credit, so a gift is never left unaudited.
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
  ) {}

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
    @Req() req: any,
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
      (manager, transaction) =>
        this.auditService.record(manager, {
          userId: authorId,
          action: 'token_gift',
          entityType: 'wallet',
          entityId: wallet.id,
          changes: { brandId, amount: body.amount, reason, transactionId: transaction.id },
          description: `Gift of ${body.amount} tokens: ${reason}`,
        }),
    )
    return { data: movement }
  }
}
