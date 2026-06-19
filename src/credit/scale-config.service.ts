import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { RequestException } from '../shared/exception/request.exception'
import {
  ScoreScaleConfig,
  ScaleConfigStatus,
} from './entities/scoreScaleConfig.entity'
import { ScaleConfig } from './domain/scale-config.types'
import { SCALE_CONFIG_V1 } from './domain/scale-config.v1'

/**
 * Gestiona las versiones de la política de scoring. La config activa es la
 * fuente de verdad del motor; cambiar la política crea una versión nueva
 * (inmutable). Ver DISEÑO_SCORING_CREDITO §7.
 */
@Injectable()
export class ScaleConfigService {
  private readonly logger = new Logger(ScaleConfigService.name)
  private cached: { config: ScaleConfig, version: number, expiry: number } | null = null
  private readonly CACHE_TTL = 5 * 60 * 1000

  constructor(
    @InjectRepository(ScoreScaleConfig, 'DBWrite')
    private readonly repo: Repository<ScoreScaleConfig>,
  ) {}

  /**
   * Devuelve la config de escala activa. Si no existe ninguna, siembra la v1
   * (valores del diseño) y la activa — así el primer cálculo no falla.
   */
  async getActiveConfig(): Promise<{ config: ScaleConfig, version: number }> {
    if (this.cached && this.cached.expiry > Date.now()) {
      return { config: this.cached.config, version: this.cached.version }
    }

    let active = await this.repo.findOne({
      where: { status: ScaleConfigStatus.ACTIVE },
    })

    if (!active) {
      active = await this.seedV1()
    }

    this.cached = {
      config: active.config,
      version: active.version,
      expiry: Date.now() + this.CACHE_TTL,
    }
    return { config: active.config, version: active.version }
  }

  /** Siembra la escala v1 como versión activa (idempotente). */
  async seedV1(): Promise<ScoreScaleConfig> {
    const existing = await this.repo.findOne({ where: { version: 1 } })
    if (existing) {
      if (existing.status !== ScaleConfigStatus.ACTIVE) {
        existing.status = ScaleConfigStatus.ACTIVE
        await this.repo.save(existing)
      }
      return existing
    }

    const errors = validateScaleConfig(SCALE_CONFIG_V1)
    if (errors.length) {
      throw new RequestException(
        { error: `Escala v1 inválida: ${errors.join('; ')}`, code: 'invalidScaleConfig' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }

    const seeded = this.repo.create({
      version: SCALE_CONFIG_V1.version,
      baseCurrency: SCALE_CONFIG_V1.baseCurrency,
      status: ScaleConfigStatus.ACTIVE,
      config: SCALE_CONFIG_V1,
      createdBy: 'seed',
    })
    const saved = await this.repo.save(seeded)
    this.logger.log(`Escala de crédito v1 sembrada y activada (${saved.id})`)
    this.cached = null
    return saved
  }

  /** Todas las versiones de escala (la más nueva primero). */
  async listVersions(): Promise<ScoreScaleConfig[]> {
    return this.repo.find({ order: { version: 'DESC' } })
  }

  /**
   * Crea una versión NUEVA de escala a partir de una config editada. No edita en
   * sitio (las versiones son inmutables): asigna el siguiente número de versión.
   * Valida antes de guardar; si `activate`, retira la activa anterior. §7.
   */
  async createVersion(
    config: ScaleConfig,
    createdBy: string,
    activate: boolean,
  ): Promise<ScoreScaleConfig> {
    const errors = validateScaleConfig(config)
    if (errors.length) {
      throw new RequestException(
        { error: `Config inválida: ${errors.join('; ')}`, code: 'invalidScaleConfig' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const max = await this.repo
      .createQueryBuilder('c')
      .select('MAX(c.version)', 'm')
      .getRawOne<{ m: string | null }>()
    const nextVersion = (Number(max?.m) || 0) + 1

    const entity = this.repo.create({
      version: nextVersion,
      baseCurrency: config.baseCurrency,
      status: activate ? ScaleConfigStatus.ACTIVE : ScaleConfigStatus.DRAFT,
      config: { ...config, version: nextVersion },
      createdBy: createdBy || 'admin',
    })

    if (activate) {
      const current = await this.repo.find({ where: { status: ScaleConfigStatus.ACTIVE } })
      for (const c of current) {
        c.status = ScaleConfigStatus.RETIRED
        await this.repo.save(c)
      }
    }

    const saved = await this.repo.save(entity)
    this.cached = null
    this.logger.log(
      `Escala v${nextVersion} creada (${activate ? 'activa' : 'draft'}) por ${createdBy}`,
    )
    return saved
  }

  /**
   * Activa una versión `draft`: valida la config, retira la activa anterior y
   * deja una sola `active`. Una config inválida activada corrompería todos los
   * scores futuros, por eso se valida acá (§7).
   */
  async activateVersion(version: number, activatedBy: string): Promise<ScoreScaleConfig> {
    const target = await this.repo.findOne({ where: { version } })
    if (!target) {
      throw new RequestException(
        { error: `Versión ${version} no existe`, code: 'scaleVersionNotFound' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (target.status === ScaleConfigStatus.RETIRED) {
      throw new RequestException(
        { error: `Versión ${version} está retirada`, code: 'scaleVersionRetired' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const errors = validateScaleConfig(target.config)
    if (errors.length) {
      throw new RequestException(
        { error: `Config inválida: ${errors.join('; ')}`, code: 'invalidScaleConfig' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const current = await this.repo.find({ where: { status: ScaleConfigStatus.ACTIVE } })
    for (const c of current) {
      if (c.version !== version) {
        c.status = ScaleConfigStatus.RETIRED
        await this.repo.save(c)
      }
    }

    target.status = ScaleConfigStatus.ACTIVE
    if (activatedBy) target.createdBy = target.createdBy || activatedBy
    const saved = await this.repo.save(target)
    this.cached = null
    this.logger.log(`Escala de crédito v${version} activada por ${activatedBy}`)
    return saved
  }
}

/**
 * Valida una config de escala antes de activarla. Devuelve la lista de errores
 * (vacía = válida). Reglas del diseño §7.
 */
export function validateScaleConfig(config: ScaleConfig): string[] {
  const errors: string[] = []

  const weightSum =
    config.weights.investment + config.weights.roas + config.weights.sales
  if (Math.abs(weightSum - 1) > 1e-9) {
    errors.push(`los pesos suman ${weightSum}, deben sumar 1.0`)
  }

  for (const key of ['investment', 'roas', 'sales'] as const) {
    const brackets = config.scales[key]
    if (!brackets?.length) {
      errors.push(`escala ${key} vacía`)
      continue
    }
    if (brackets[brackets.length - 1].upTo !== null) {
      errors.push(`escala ${key} no termina en un tramo sin tope (upTo null)`)
    }
    for (let i = 0; i < brackets.length - 1; i++) {
      const a = brackets[i].upTo
      const b = brackets[i + 1].upTo
      if (a === null || (b !== null && a >= b)) {
        errors.push(`escala ${key}: tramos no monótonos en índice ${i}`)
      }
    }
    for (const bracket of brackets) {
      if (bracket.score < 0 || bracket.score > 100) {
        errors.push(`escala ${key}: subscore ${bracket.score} fuera de 0–100`)
      }
    }
  }

  // min_roas debe caer en un borde de tramo ROAS.
  const roasEdges = config.scales.roas.map((b) => b.upTo).filter((u) => u !== null)
  if (!roasEdges.includes(config.vetoes.minRoas)) {
    errors.push(`vetoes.minRoas=${config.vetoes.minRoas} no coincide con un borde de tramo ROAS`)
  }

  // tiers cubren 0–100 sin huecos.
  const tiers = [...config.tiers].sort((a, b) => a.scoreMin - b.scoreMin)
  if (tiers.length === 0 || tiers[0].scoreMin !== 0) {
    errors.push('los niveles no arrancan en 0')
  }
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].scoreMax < tiers[i].scoreMin) {
      errors.push(`nivel ${tiers[i].key}: scoreMax < scoreMin`)
    }
    if (i > 0 && tiers[i].scoreMin !== tiers[i - 1].scoreMax + 1) {
      errors.push(`hueco/solape entre ${tiers[i - 1].key} y ${tiers[i].key}`)
    }
  }
  if (tiers.length && tiers[tiers.length - 1].scoreMax !== 100) {
    errors.push('los niveles no llegan a 100')
  }

  // tierRoasCaps referencian niveles existentes.
  const tierKeys = new Set(config.tiers.map((t) => t.key))
  for (const key of ['growth_seller', 'pro_marketer', 'elite']) {
    if (!tierKeys.has(key)) {
      errors.push(`tierRoasCaps referencia el nivel inexistente "${key}"`)
    }
  }

  return errors
}
