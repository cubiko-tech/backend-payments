import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, Repository } from 'typeorm'
import { RequestException } from '../shared/exception/request.exception'
import { TokenPackage } from './entities/token-package.entity'

export const MIN_PACKAGE_PRICE_USD = 10

export type TokenPackageChanges = Partial<
  Pick<TokenPackage, 'label' | 'priceUsd' | 'purchasedTokens' | 'bonusTokens' | 'active'>
>

/** What a buyer and the admin screen see of a package; amounts are numbers, not decimal strings. */
export interface TokenPackageView {
  id: string
  slug: string
  label: string
  priceUsd: number
  purchasedTokens: number
  bonusTokens: number
  active: boolean
}

export interface TokenPackageChange {
  before: TokenPackageView
  after: TokenPackageView
}

/** The token package catalog: buyers read the active packages, a super admin edits them. */
@Injectable()
export class TokenPackageService {
  constructor(
    @InjectRepository(TokenPackage, 'DBWrite')
    private readonly packages: Repository<TokenPackage>,
  ) {}

  async listActive(): Promise<TokenPackageView[]> {
    const rows = await this.packages.find({ where: { active: true }, order: { priceUsd: 'ASC' } })
    return rows.map(toPackageView)
  }

  /** The active package a checkout charges; 404 `TOKEN_PACKAGE_NOT_FOUND` when absent or inactive. */
  async findActive(id: string): Promise<TokenPackageView> {
    const row = await this.packages.findOne({ where: { id, active: true } })
    if (!row) throw packageNotFound()
    return toPackageView(row)
  }

  /**
   * Applies `changes` and returns the package before and after; 404 when the id is unknown. The
   * caller validates the values; the table's CHECK constraints refuse what slips through. `audit`
   * runs in the same transaction: when it throws, the package stays as it was.
   */
  async update(
    id: string,
    changes: TokenPackageChanges,
    audit?: (manager: EntityManager, change: TokenPackageChange) => Promise<unknown>,
  ): Promise<TokenPackageChange> {
    return this.packages.manager.transaction(async (manager) => {
      const row = await manager.findOne(TokenPackage, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!row) throw packageNotFound()
      const before = toPackageView(row)
      Object.assign(row, changes)
      const change = { before, after: toPackageView(await manager.save(TokenPackage, row)) }
      if (audit) await audit(manager, change)
      return change
    })
  }
}

function packageNotFound() {
  return new RequestException(
    { code: 'TOKEN_PACKAGE_NOT_FOUND', message: 'Token package not found' },
    HttpStatus.NOT_FOUND,
  )
}

function toPackageView(row: TokenPackage): TokenPackageView {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    priceUsd: Number(row.priceUsd),
    purchasedTokens: Number(row.purchasedTokens),
    bonusTokens: Number(row.bonusTokens),
    active: row.active,
  }
}
