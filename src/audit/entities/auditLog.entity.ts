import { Column, Entity, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'

@Entity('audit_log')
@Index('IDX_audit_log_entity', ['entityType', 'entityId', 'createdAt'])
@Index('IDX_audit_log_user', ['userId', 'createdAt'])
@Index('IDX_audit_log_action', ['action', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column() userId: string
  @Column() action: string
  @Column() entityType: string
  @Column() entityId: string
  @Column({ type: 'jsonb', nullable: true }) changes: any
  @Column({ type: 'text', nullable: true }) description: string
  @Column({ nullable: true }) ip: string
  @Column({ nullable: true }) userAgent: string
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
}
