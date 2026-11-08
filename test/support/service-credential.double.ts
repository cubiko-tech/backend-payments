import { ServiceCredentialService } from '../../src/shared/auth/service-credential.service'

/**
 * Provides `ServiceCredentialService` to a test module that mounts `ApiAuthGuard` and does not
 * exercise service keys. It answers like the real service to a key it does not know.
 */
export const unknownServiceKeys = {
  provide: ServiceCredentialService,
  // R17: those suites never send a `psk.` key; service-credential.e2e runs the real lookup.
  useValue: { authenticate: async () => null },
}
