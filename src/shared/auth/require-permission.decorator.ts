import { SetMetadata } from '@nestjs/common'

export const API_PERMISSION_KEY = 'credit_permission'
export const API_SUPER_ADMIN_KEY = 'require_super_admin'

/**
 * Marca un handler como protegido por un permiso efectivo de crédito
 * (credit:bureau | credit:scale | credit:runs). Lo aplica `ApiAuthGuard`.
 */
export const RequirePermission = (permission: string) => SetMetadata(API_PERMISSION_KEY, permission)

export const RequireSuperAdmin = () => SetMetadata(API_SUPER_ADMIN_KEY, true)
