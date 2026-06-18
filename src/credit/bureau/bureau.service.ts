import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { MoreThan, Repository } from 'typeorm'

import { RequestException } from '../../shared/exception/request.exception'
import { AuditService } from '../../audit/audit.service'
import { CreditProfile } from '../entities/creditProfile.entity'
import { BureauCheck } from '../entities/bureauCheck.entity'
import { BureauBand } from '../domain/scale-config.types'
import {
  BUREAU_THRESHOLDS,
  DEFAULT_BUREAU_VALID_DAYS,
  mapBand,
} from './bureau.config'

export interface ActiveBand {
  band: BureauBand
  checkId: string
}

/**
 * Buró: perfil de crédito (documento legal + consentimiento habeas data), checks
 * con vigencia keyed por documento, y la banda vigente que consume el motor.
 *
 * Regla dura (Leyes 1266/1581): ningún check se crea sin consentimiento vigente
 * registrado en el perfil — se valida acá, no en el controller. Ver §4 del diseño.
 */
@Injectable()
export class BureauService {
  private readonly logger = new Logger(BureauService.name)

  constructor(
    @InjectRepository(CreditProfile, 'DBWrite')
    private readonly profileRepo: Repository<CreditProfile>,
    @InjectRepository(CreditProfile, 'DBRead')
    private readonly profileReadRepo: Repository<CreditProfile>,
    @InjectRepository(BureauCheck, 'DBWrite')
    private readonly checkRepo: Repository<BureauCheck>,
    @InjectRepository(BureauCheck, 'DBRead')
    private readonly checkReadRepo: Repository<BureauCheck>,
    private readonly audit: AuditService,
  ) {}

  async getProfile(brandId: string): Promise<CreditProfile | null> {
    return this.profileReadRepo.findOne({ where: { brandId } })
  }

  /** Crea o actualiza el documento legal del perfil (no toca consentimiento). */
  async upsertProfile(
    brandId: string,
    data: { document: string; documentType: string; country?: string },
  ): Promise<CreditProfile> {
    const existing = await this.profileRepo.findOne({ where: { brandId } })
    const profile = existing ?? this.profileRepo.create({ brandId })
    profile.document = data.document
    profile.documentType = data.documentType
    if (data.country) profile.country = data.country
    return this.profileRepo.save(profile)
  }

  /** Registra el consentimiento habeas data del titular. */
  async grantConsent(
    brandId: string,
    data: { version: string; source: string },
    createdBy: string,
  ): Promise<CreditProfile> {
    const profile = await this.profileRepo.findOne({ where: { brandId } })
    if (!profile) {
      throw new RequestException(
        { error: 'Registrá primero el documento del perfil', code: 'noProfile' },
        HttpStatus.BAD_REQUEST,
      )
    }
    profile.consentGrantedAt = new Date()
    profile.consentVersion = data.version
    profile.consentSource = data.source
    const saved = await this.profileRepo.save(profile)
    await this.audit.log(
      createdBy, 'credit.consent.grant', 'credit_profile', profile.id,
      { brandId, version: data.version, source: data.source },
      'Consentimiento habeas data registrado',
    )
    return saved
  }

  /**
   * Carga un check manual: requiere documento + consentimiento vigente. Mapea el
   * puntaje a banda (o usa la banda explícita) y la cachea con vigencia. Vector de
   * fraude interno → audita siempre con el operador.
   */
  async createManualCheck(
    brandId: string,
    data: {
      provider?: string
      rawScore?: number
      scaleMax?: number
      band?: BureauBand
      validDays?: number
    },
    createdBy: string,
  ): Promise<BureauCheck> {
    const profile = await this.profileReadRepo.findOne({ where: { brandId } })
    if (!profile?.document) {
      throw new RequestException(
        { error: 'El perfil no tiene documento legal', code: 'noDocument' },
        HttpStatus.BAD_REQUEST,
      )
    }
    // Regla dura: sin consentimiento vigente no hay consulta de buró.
    if (!profile.consentGrantedAt) {
      throw new RequestException(
        { error: 'Falta consentimiento habeas data del titular', code: 'consentRequired' },
        HttpStatus.FORBIDDEN,
      )
    }

    const provider = data.provider ?? 'manual'
    const thresholds = BUREAU_THRESHOLDS[provider] ?? BUREAU_THRESHOLDS.manual
    if (data.band === undefined && data.rawScore === undefined) {
      throw new RequestException(
        { error: 'Indicá rawScore o band', code: 'noScoreOrBand' },
        HttpStatus.BAD_REQUEST,
      )
    }
    const band = data.band ?? mapBand(data.rawScore as number, thresholds)

    const now = new Date()
    const validDays = data.validDays ?? DEFAULT_BUREAU_VALID_DAYS
    const validUntil = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000)

    const check = await this.checkRepo.save(
      this.checkRepo.create({
        provider,
        document: profile.document,
        documentType: profile.documentType,
        country: profile.country,
        rawScore: data.rawScore ?? null,
        scaleMax: data.scaleMax ?? thresholds.scaleMax,
        band,
        checkedAt: now,
        validUntil,
        createdBy,
      }),
    )

    await this.audit.log(
      createdBy, 'credit.bureau.create', 'credit_bureau_check', check.id,
      { brandId, provider, band, rawScore: data.rawScore ?? null },
      `Check de buró ${provider} cargado: banda ${band}`,
    )
    return check
  }

  /** Banda vigente para la marca (vía documento del perfil), o null si no hay. */
  async getActiveBand(brandId: string): Promise<ActiveBand | null> {
    const profile = await this.profileReadRepo.findOne({ where: { brandId } })
    if (!profile?.document) return null
    const check = await this.checkReadRepo.findOne({
      where: { document: profile.document, validUntil: MoreThan(new Date()) },
      order: { checkedAt: 'DESC' },
    })
    return check?.band ? { band: check.band, checkId: check.id } : null
  }

  /** Historial de checks de la marca (por su documento). */
  async getChecksByBrand(brandId: string): Promise<BureauCheck[]> {
    const profile = await this.profileReadRepo.findOne({ where: { brandId } })
    if (!profile?.document) return []
    return this.checkReadRepo.find({
      where: { document: profile.document },
      order: { checkedAt: 'DESC' },
      take: 50,
    })
  }
}
