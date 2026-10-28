import { HttpStatus, Logger } from '@nestjs/common'
import { ClientPlatformService } from '../../client/client-platform.service'
import { RequestException } from '../exception/request.exception'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertValidBrandId(brandId: unknown): string {
  if (typeof brandId !== 'string' || !UUID_REGEX.test(brandId.trim())) {
    throw new RequestException(
      { code: 'INVALID_BRAND_ID', message: 'brandId is required and must be a valid UUID' },
      HttpStatus.BAD_REQUEST,
    )
  }
  return brandId.trim()
}

export function isPrivilegedCaller(req: any): boolean {
  return Boolean(req?.user?.isSuperAdmin || req?.user?.id === 'server')
}

export async function assertBrandAccess(
  platformClient: ClientPlatformService,
  logger: Logger,
  req: any,
  brandId: unknown,
  route: string,
): Promise<string> {
  const validBrandId = assertValidBrandId(brandId)

  if (isPrivilegedCaller(req)) {
    return validBrandId
  }

  const userId = req?.user?.id
  const allowed = await platformClient.canViewBrandCredit(userId, validBrandId)
  if (!allowed) {
    logger.warn(
      `Forbidden brand access: user=${userId ?? 'unknown'} brandId=${validBrandId} route=${route}`,
    )
    throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
  }

  return validBrandId
}

export async function assertResourceBrandAccess(
  platformClient: ClientPlatformService,
  logger: Logger,
  req: any,
  resourceBrandId: unknown,
  route: string,
): Promise<void> {
  if (isPrivilegedCaller(req)) {
    return
  }

  const userId = req?.user?.id
  const brandId = typeof resourceBrandId === 'string' ? resourceBrandId.trim() : ''
  const allowed = brandId ? await platformClient.canViewBrandCredit(userId, brandId) : false

  if (!allowed) {
    logger.warn(
      `Forbidden brand access: user=${userId ?? 'unknown'} brandId=${brandId || 'unknown'} route=${route}`,
    )
    throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
  }
}
