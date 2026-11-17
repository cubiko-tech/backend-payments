import { MODULE_METADATA } from '@nestjs/common/constants'

import { ApiAuthGuard } from './api-auth.guard'
import { AuthModule } from './auth.module'
import { clientOf, ServiceCredentialService } from './service-credential.service'

describe('service credential key shape (LOC-173)', () => {
  it('reads the client of a well-formed key', () => {
    expect(clientOf('psk.roax-ads.c2VjcmV0')).toBe('roax-ads')
  })

  it.each([
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InUxIn0.sig'],
    ['no secret', 'psk.roax-ads.'],
    ['an extra part', 'psk.roax-ads.secret.more'],
    ['an uppercase client', 'psk.ROAX-ADS.secret'],
    ['a two-letter client', 'psk.ro.secret'],
    ['no prefix', 'roax-ads.secret'],
  ])('refuses %s', (_label, key) => {
    // R15: red when clientOf skips the client pattern or the part count: it returns a name.
    expect(clientOf(key)).toBeNull()
  })

  it('AuthModule provides the credential service next to the guard', () => {
    // R15: red when AuthModule drops the service: every key gets 401 in the running app.
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule)

    expect(providers).toEqual(expect.arrayContaining([ApiAuthGuard, ServiceCredentialService]))
  })
})
