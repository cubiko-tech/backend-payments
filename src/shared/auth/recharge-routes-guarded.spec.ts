/**
 * Every route under `recharge` takes only ROAX Ads' service credential (LOC-173). This spec reads
 * every controller of `src/`, so a new recharge route cannot skip the mark.
 */
import { Controller, Post } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { readdirSync } from 'fs'
import { join } from 'path'

import {
  API_SERVICE_CLIENT_KEY,
  RequireServiceClient,
  ROAX_ADS_CLIENT,
} from './require-permission.decorator'

type ControllerClass = new (...args: never[]) => unknown

const firstPath = (value: unknown): string =>
  String((Array.isArray(value) ? value[0] : value) ?? '').replace(/^\/+/, '')

/** `Class.handler` of every route under `recharge` that does not require ROAX Ads' credential. */
function rechargeRoutesWithoutAdsCredential(controllers: ControllerClass[]): string[] {
  return controllers.flatMap((controller) => {
    const prefix = firstPath(Reflect.getMetadata(PATH_METADATA, controller))
    const onClass = Reflect.getMetadata(API_SERVICE_CLIENT_KEY, controller)
    return Object.getOwnPropertyNames(controller.prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => {
        const handler = controller.prototype[name]
        const path = Reflect.getMetadata(PATH_METADATA, handler)
        if (path === undefined) return false
        const route = [prefix, firstPath(path)].filter(Boolean).join('/')
        if (!/^recharge(\/|$)/.test(route)) return false
        return (Reflect.getMetadata(API_SERVICE_CLIENT_KEY, handler) ?? onClass) !== ROAX_ADS_CLIENT
      })
      .map((name) => `${controller.name}.${name}`)
  })
}

function controllersOf(dir: string): ControllerClass[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return controllersOf(path)
    if (!entry.name.endsWith('.controller.ts')) return []
    return Object.values(jest.requireActual<Record<string, unknown>>(path)).filter(
      (value): value is ControllerClass =>
        typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value),
    )
  })
}

@Controller('recharge/dropi')
class UnguardedRecharge {
  @Post() create() {}
}

@Controller('recharge/dropi')
@RequireServiceClient(ROAX_ADS_CLIENT)
class GuardedRecharge {
  @Post() create() {}
}

@Controller()
class OtherClientRecharge {
  @Post('recharge/dropi/:id/result') @RequireServiceClient('other-service') report() {}
}

describe('recharge routes require the ROAX Ads service credential', () => {
  it('flags a recharge route without @RequireServiceClient(ROAX_ADS_CLIENT)', () => {
    // R15: red when the check stops reading the class path: the unguarded route is not flagged.
    expect(rechargeRoutesWithoutAdsCredential([UnguardedRecharge])).toEqual([
      'UnguardedRecharge.create',
    ])
  })

  it('flags a recharge handler that requires another client', () => {
    // R15: red when the check accepts any client name: the other-service route passes.
    expect(rechargeRoutesWithoutAdsCredential([OtherClientRecharge])).toEqual([
      'OtherClientRecharge.report',
    ])
  })

  it('accepts a recharge controller that requires ROAX Ads on the class', () => {
    expect(rechargeRoutesWithoutAdsCredential([GuardedRecharge])).toEqual([])
  })

  it('no controller of src/ exposes a recharge route without the ROAX Ads credential', () => {
    const controllers = controllersOf(join(__dirname, '..', '..'))

    expect(controllers.length).toBeGreaterThan(10)
    expect(rechargeRoutesWithoutAdsCredential(controllers)).toEqual([])
  })
})
