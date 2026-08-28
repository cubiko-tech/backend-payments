import { Logger } from '@nestjs/common'

import { downgradeBrandToFree, freePlanSlug } from './plan-downgrade.util'

/**
 * Las dos ramas del helper que ningún disparador ejercita: la marca que ya está
 * en `free` y el corte cuando roles rechaza el retiro. El resto de la conducta
 * (los tres disparadores) vive en `tasks.service.spec.ts` y
 * `confio-subscription-webhook.service.spec.ts`.
 */
describe('downgradeBrandToFree', () => {
  let roles: { removePlanFromBrand: jest.Mock; assignPlanToBrand: jest.Mock }

  beforeEach(() => {
    roles = {
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
    }
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it('saca el plan pago y asigna free sin expiresAt', async () => {
    const ok = await downgradeBrandToFree(roles as any, 'b1', 'pro')

    expect(ok).toBe(true)
    expect(roles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
    expect(roles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
    expect(roles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
  })

  // La marca que ya estaba en `free` conserva el baseline: si se la retirara sin
  // reponerla quedaría SIN NINGÚN plan, que es lo contrario de degradarla.
  // Alcanzable con un trial sobre un plan de precio 0.
  it('una marca que ya está en free no se toca: ni se retira ni se re-asigna', async () => {
    const ok = await downgradeBrandToFree(roles as any, 'b1', freePlanSlug())

    expect(ok).toBe(true)
    expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
    expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
  })

  it('si el retiro es rechazado no se asigna free', async () => {
    roles.removePlanFromBrand.mockResolvedValue(false)

    const ok = await downgradeBrandToFree(roles as any, 'b1', 'pro')

    // Dejar el plan pago puesto Y `free` encima es peor que reintentar entero.
    expect(ok).toBe(false)
    expect(roles.assignPlanToBrand).not.toHaveBeenCalled()
  })

  it('si la asignación de free es rechazada la degradación no se da por hecha', async () => {
    roles.assignPlanToBrand.mockResolvedValue(false)

    expect(await downgradeBrandToFree(roles as any, 'b1', 'pro')).toBe(false)
  })

  it('el slug de free se lee del entorno en CADA llamada', async () => {
    const previo = process.env.FREE_PLAN_SLUG
    process.env.FREE_PLAN_SLUG = 'basico'
    try {
      await downgradeBrandToFree(roles as any, 'b1', 'pro')
      expect(roles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'basico')
    } finally {
      if (previo === undefined) delete process.env.FREE_PLAN_SLUG
      else process.env.FREE_PLAN_SLUG = previo
    }
  })
})
