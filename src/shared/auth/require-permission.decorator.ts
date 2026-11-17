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

export const API_SERVICE_CLIENT_KEY = 'require_service_client'

/** The client name of ROAX Ads' service credential, the only one that recharges from Dropi. */
export const ROAX_ADS_CLIENT = 'roax-ads'

/**
 * Lets in only the service credential of `client`, on a handler or a whole controller: the server
 * token, users and super admins get 403. A service credential gets 403 on any route without it.
 */
export const RequireServiceClient = (client: string) => SetMetadata(API_SERVICE_CLIENT_KEY, client)

export const API_ON_BEHALF_OF_KEY = 'require_on_behalf_of_user'

/** Header that carries the token of the person a service calls for, as `Bearer <token>`. */
export const ON_BEHALF_OF_HEADER = 'x-user-authorization'

/**
 * Next to `@RequireServiceClient`, also requires the token of the person the service calls for in
 * `X-User-Authorization`, resolved as any user's session; 401 without it. The guard leaves that
 * person in `req.onBehalfOf`. The server token and service credentials are never accepted there.
 */
export const RequireOnBehalfOfUser = () => SetMetadata(API_ON_BEHALF_OF_KEY, true)

export const API_UPSTREAM_TIMEOUT_KEY = 'upstream_timeout_ms'

/**
 * Caps at `ms` the call to auth that resolves the person of `X-User-Authorization`, and makes auth
 * not answering a 503 instead of a 401. Routes without it keep the 10 s and the 401.
 */
export const UpstreamTimeout = (ms: number) => SetMetadata(API_UPSTREAM_TIMEOUT_KEY, ms)
