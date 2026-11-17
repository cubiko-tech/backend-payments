import { Column, Entity } from 'typeorm'
import { Content } from '../../entities/content.abstract'

/** A service allowed to call Pagos: its client name, the SHA-256 of its key and whether it is on. */
@Entity('service_credentials')
export class ServiceCredential extends Content {
  @Column({ length: 50, unique: true }) client: string
  @Column({ type: 'char', length: 64 }) keyHash: string
  @Column({ default: true }) active: boolean
}
