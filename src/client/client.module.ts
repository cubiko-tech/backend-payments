import { Module, Global } from '@nestjs/common'
import { ClientRolesService } from './client-roles.service'

@Global()
@Module({
  providers: [ClientRolesService],
  exports: [ClientRolesService],
})
export class ClientModule {}
