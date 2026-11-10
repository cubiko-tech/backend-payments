import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { EntityManager, Repository } from 'typeorm'

import { isUniqueConstraintViolation } from '../../checkout/checkout-idempotency'
import { RequestException } from '../exception/request.exception'
import { ServiceCredential } from './entities/service-credential.entity'

/** Prefix that tells a service key from a JWT (which starts with `eyJ`). */
export const SERVICE_KEY_PREFIX = 'psk.'
export const SERVICE_CLIENT_PATTERN = /^[a-z0-9-]{3,50}$/

export interface ServiceCredentialView {
  id: string
  client: string
  active: boolean
}

/** The view plus the key in clear: returned once, by the creation and the rotation, never stored. */
export interface IssuedServiceCredential extends ServiceCredentialView {
  key: string
}

type Audit = (manager: EntityManager, view: ServiceCredentialView) => Promise<unknown>

/**
 * Service credentials kept by Pagos, one per client. A key is `psk.<client>.<secret>` with 32
 * random bytes; only its SHA-256 is stored, and neither the key nor the hash is ever logged.
 */
@Injectable()
export class ServiceCredentialService {
  constructor(
    @InjectRepository(ServiceCredential, 'DBWrite')
    private readonly credentials: Repository<ServiceCredential>,
  ) {}

  /**
   * The client a key belongs to, or null when the key is malformed, unknown, inactive or not the
   * current one. Reads the primary: a rotation or a deactivation holds from its commit on.
   */
  async authenticate(key: string): Promise<string | null> {
    const client = clientOf(key)
    if (!client) return null
    const row = await this.credentials.findOne({ where: { client } })
    if (!row?.active) return null
    const presented = Buffer.from(hashKey(key), 'hex')
    const stored = Buffer.from(row.keyHash, 'hex')
    return presented.length === stored.length && timingSafeEqual(presented, stored) ? client : null
  }

  /** Creates the credential of `client`; 409 `SERVICE_CREDENTIAL_EXISTS` when it already has one. */
  async create(client: string, audit: Audit): Promise<IssuedServiceCredential> {
    const key = newKey(client)
    try {
      return await this.credentials.manager.transaction(async (manager) => {
        const row = await manager.save(
          ServiceCredential,
          manager.create(ServiceCredential, { client, keyHash: hashKey(key), active: true }),
        )
        await audit(manager, toView(row))
        return { ...toView(row), key }
      })
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new RequestException(
          { code: 'SERVICE_CREDENTIAL_EXISTS', message: 'The client already has a credential' },
          HttpStatus.CONFLICT,
        )
      }
      throw error
    }
  }

  /** Replaces the key of `client`; the previous one stops working when this commits. */
  rotate(client: string, audit: Audit): Promise<IssuedServiceCredential> {
    const key = newKey(client)
    return this.change(client, { keyHash: hashKey(key) }, audit).then((view) => ({ ...view, key }))
  }

  /** Turns the credential of `client` on or off, keeping its key. */
  setActive(client: string, active: boolean, audit: Audit): Promise<ServiceCredentialView> {
    return this.change(client, { active }, audit)
  }

  private change(
    client: string,
    changes: Partial<Pick<ServiceCredential, 'keyHash' | 'active'>>,
    audit: Audit,
  ): Promise<ServiceCredentialView> {
    return this.credentials.manager.transaction(async (manager) => {
      const row = await manager.findOne(ServiceCredential, {
        where: { client },
        lock: { mode: 'pessimistic_write' },
      })
      if (!row) {
        throw new RequestException(
          { code: 'SERVICE_CREDENTIAL_NOT_FOUND', message: 'The client has no credential' },
          HttpStatus.NOT_FOUND,
        )
      }
      Object.assign(row, changes)
      const view = toView(await manager.save(ServiceCredential, row))
      await audit(manager, view)
      return view
    })
  }
}

/** The client a well-formed key names, or null. */
export function clientOf(key: string): string | null {
  if (!key.startsWith(SERVICE_KEY_PREFIX)) return null
  const [client, secret, ...rest] = key.slice(SERVICE_KEY_PREFIX.length).split('.')
  if (rest.length || !secret || !SERVICE_CLIENT_PATTERN.test(client)) return null
  return client
}

function newKey(client: string): string {
  return `${SERVICE_KEY_PREFIX}${client}.${randomBytes(32).toString('base64url')}`
}

// SHA-256 without salt is enough: the key carries 256 random bits, it is not a password.
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function toView(row: ServiceCredential): ServiceCredentialView {
  return { id: row.id, client: row.client, active: row.active }
}
