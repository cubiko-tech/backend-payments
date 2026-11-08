import { Body, Controller, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Response } from 'express'

import { ClientPlatformService } from '../client/client-platform.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { assertValidBrandId } from '../shared/auth/brand-scope.util'
import {
  RequireOnBehalfOfUser,
  RequireServiceClient,
  ROAX_ADS_CLIENT,
  UpstreamTimeout,
} from '../shared/auth/require-permission.decorator'
import { RequestException } from '../shared/exception/request.exception'
import { DebitTokensDto } from './dto/debit-tokens.dto'
import { RefundDebitDto } from './dto/refund-debit.dto'
import { isLimitHit, MovementLimits, walletBusy, withinMs } from './movement-limits'
import { TokenMovement, TokenWalletService, fail } from './token-wallet.service'

/**
 * Budget of a debit, 4.5 s in all under the 5 s ROAX Ads waits for Pagos: auth 1 s, platform 1 s,
 * the wallet lookup 0.5 s, a pool connection 0.5 s and the whole transaction 1.5 s.
 */
const UPSTREAM_TIMEOUT_MS = 1000
const WALLET_LOOKUP_TIMEOUT_MS = 500
const DEBIT_LIMITS: MovementLimits = { connectTimeoutMs: 500, transactionTimeoutMs: 1500 }

export const DEBIT_REFERENCE = 'token_debit'

interface ServiceRequest {
  user: { serviceClient: string }
  onBehalfOf?: { id: string }
}

/** Keys of a service live behind its client name: `transactions.idempotencyKey` is unique. */
export const debitKeyOf = (client: string, key: string) => `${client}:debit:${key}`
const refundKeyOf = (client: string, debitKey: string, key: string) =>
  `${client}:refund:${debitKey}:${key}`

@ApiTags('Token wallet')
@Controller('token-wallet/debits')
@UseGuards(ApiAuthGuard)
@RequireServiceClient(ROAX_ADS_CLIENT)
export class TokenDebitController {
  private readonly logger = new Logger(TokenDebitController.name)

  constructor(
    private readonly tokenWallets: TokenWalletService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Post()
  @RequireOnBehalfOfUser()
  @UpstreamTimeout(UPSTREAM_TIMEOUT_MS)
  @ApiOperation({ summary: 'ROAX Ads debits the brand token wallet for a user of the brand' })
  @ApiResponse({ status: 201, description: 'Debited: gift, then purchased, then Dropi if inDropi' })
  @ApiResponse({ status: 200, description: 'Same key and tokens: the debit already made' })
  @ApiResponse({ status: 401, description: 'No user token' })
  @ApiResponse({
    status: 403,
    description: 'Not ROAX Ads, or the user is not a member of the brand',
  })
  @ApiResponse({ status: 409, description: 'Key already used with other tokens or brand' })
  @ApiResponse({ status: 422, description: 'Not enough tokens, or the wallet is not active' })
  @ApiResponse({ status: 503, description: 'Auth, platform or the wallet did not answer in time' })
  async debit(
    @Body() body: DebitTokensDto,
    @Req() req: ServiceRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const brandId = assertValidBrandId(body.brandId)
    const userId = req.onBehalfOf!.id
    const client = req.user.serviceClient
    if (!(await this.platformClient.canViewBrandCredit(userId, brandId, UPSTREAM_TIMEOUT_MS))) {
      this.logger.warn(`Forbidden token debit: user=${userId} brandId=${brandId}`)
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
    }
    const lookup = this.tokenWallets.findTokenWalletId(brandId)
    const walletId = await withinMs(lookup, WALLET_LOOKUP_TIMEOUT_MS).catch((error) => {
      throw isLimitHit(error) ? walletBusy() : error
    })
    if (!walletId) {
      throw fail('INSUFFICIENT_BALANCE', 'Insufficient tokens', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    const movement = await this.tokenWallets.debitTokens(
      walletId,
      body.tokens,
      { brandId, inDropi: body.inDropi === true },
      { referenceType: DEBIT_REFERENCE, metadata: { serviceClient: client, userId } },
      debitKeyOf(client, body.idempotencyKey),
      DEBIT_LIMITS,
    )
    res.status(movement.replayed ? HttpStatus.OK : HttpStatus.CREATED)
    return { data: { wallet: movement.wallet, debit: summaryOf(movement) } }
  }

  @Post('refunds')
  @ApiOperation({ summary: 'ROAX Ads gives back tokens of one of its debits, in whole or in part' })
  @ApiResponse({ status: 201, description: 'Refunded: Dropi, then purchased, then gift' })
  @ApiResponse({ status: 200, description: 'Same refund key and tokens: the refund already made' })
  @ApiResponse({ status: 403, description: 'Not the ROAX Ads credential' })
  @ApiResponse({
    status: 404,
    description: 'No debit with that key yet for the brand: retry with the same refund key',
  })
  @ApiResponse({ status: 409, description: 'Refund key already used with other tokens' })
  @ApiResponse({
    status: 422,
    description: 'Past what the debit has left, or the wallet is closed',
  })
  async refund(
    @Body() body: RefundDebitDto,
    @Req() req: ServiceRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const brandId = assertValidBrandId(body.brandId)
    const client = req.user.serviceClient
    const walletId = await this.tokenWallets.findTokenWalletId(brandId)
    if (!walletId) {
      throw fail('DEBIT_NOT_FOUND', 'No debit with this key on the wallet', HttpStatus.NOT_FOUND)
    }
    const debitKey = debitKeyOf(client, body.debitKey)
    const movement = await this.tokenWallets.refundDebit(
      walletId,
      body.tokens,
      { brandId, debitKey },
      { metadata: { serviceClient: client } },
      refundKeyOf(client, body.debitKey, body.refundKey),
    )
    res.status(movement.replayed ? HttpStatus.OK : HttpStatus.CREATED)
    return { data: { wallet: movement.wallet, refund: summaryOf(movement) } }
  }
}

function summaryOf(movement: TokenMovement) {
  const { transaction, replayed } = movement
  const tokenSplit = transaction.metadata?.tokenSplit ?? null
  return { id: transaction.id, tokens: Number(transaction.amount), tokenSplit, replayed }
}
