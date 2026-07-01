import { Module, Global } from '@nestjs/common'
import { ClientRolesService } from './client-roles.service'
import { ClientPlatformService } from './client-platform.service'

@Global()
@Module({
  providers: [ClientRolesService, ClientPlatformService],
  exports: [ClientRolesService, ClientPlatformService],
})
export class ClientModule {}
