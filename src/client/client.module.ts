import { Module, Global } from '@nestjs/common'
import { ClientRolesService } from './client-roles.service'
import { ClientPlatformService } from './client-platform.service'
import { ClientAuthService } from './client-auth.service'

@Global()
@Module({
  providers: [ClientRolesService, ClientPlatformService, ClientAuthService],
  exports: [ClientRolesService, ClientPlatformService, ClientAuthService],
})
export class ClientModule {}
