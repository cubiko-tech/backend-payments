import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AuditLog } from './entities/auditLog.entity'
import { AuditService } from './audit.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog], 'DBWrite'),
    TypeOrmModule.forFeature([AuditLog], 'DBRead'),
  ],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
