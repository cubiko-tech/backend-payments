import { SetMetadata } from '@nestjs/common'

export const CREDIT_PERMISSION_KEY = 'credit_permission'

/**
 * Marca un handler como protegido por un permiso efectivo de crédito
 * (credit:bureau | credit:scale | credit:runs). Lo aplica `CreditPermissionGuard`.
 */
export const RequireCreditPermission = (permission: string) =>
  SetMetadata(CREDIT_PERMISSION_KEY, permission)
