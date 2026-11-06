import { SetMetadata } from '@nestjs/common'

export const API_PERMISSION_KEY = 'credit_permission'
export const API_SUPER_ADMIN_KEY = 'require_super_admin'

/**
 * Marca un handler como protegido por un permiso efectivo de crédito
 * (credit:bureau | credit:scale | credit:runs). Lo aplica `ApiAuthGuard`.
 */
export const RequirePermission = (permission: string) => SetMetadata(API_PERMISSION_KEY, permission)

export const RequireSuperAdmin = () => SetMetadata(API_SUPER_ADMIN_KEY, true)

export const API_SESSION_ONLY_KEY = 'require_session_user'

/**
 * Refuses the server token (`ACCESS_SERVER`) with 403 on a handler or a whole controller: the route
 * needs a person's session, whose id is the author it records.
 */
export const RequireSessionUser = () => SetMetadata(API_SESSION_ONLY_KEY, true)
