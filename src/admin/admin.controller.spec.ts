import { AdminController } from './admin.controller'
import { SubscriptionStatus } from '../subscription/entities/subscription.entity'

const mockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  save: jest.fn((d: any) => Promise.resolve(d)),
  create: jest.fn((d: any) => d),
  count: jest.fn().mockResolvedValue(0),
})

/**
 * Extensión manual de una suscripción desde el panel admin.
 *
 * Se cubre acá y no en un e2e porque lo que hay que fijar es la INVARIANTE de
 * `accessEndsAt` (`subscription.entity.ts`): todo escritor que mueve el fin del
 * servicio tiene que mover también la fecha de corte cuando hay una baja pendiente.
 * Sin eso, «extender 30 días» sobre una fila dada de baja movía `currentPeriodEnd`
 * —que ya no gobierna el acceso— y no le daba a la marca ni un día más.
 */
describe('AdminController — extendSubscription', () => {
  let controller: AdminController
  let subscriptionWriteRepo: ReturnType<typeof mockRepo>
  let auditService: { log: jest.Mock }

  beforeEach(() => {
    subscriptionWriteRepo = mockRepo()
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

    controller = new AdminController(
      mockRepo() as any, // subscriptionReadRepo
      subscriptionWriteRepo as any, // subscriptionWriteRepo
      mockRepo() as any, // paymentReadRepo
      mockRepo() as any, // paymentWriteRepo
      mockRepo() as any, // walletReadRepo
      mockRepo() as any, // walletWriteRepo
      mockRepo() as any, // snapshotReadRepo
      mockRepo() as any, // providerReadRepo
      mockRepo() as any, // providerWriteRepo
      mockRepo() as any, // transactionWriteRepo
      auditService as any,
      {} as any, // creditService
    )
  })

  const fila = (over: Record<string, any> = {}): any => ({
    id: 'sub-1',
    brandId: 'brand-1',
    status: SubscriptionStatus.ACTIVE,
    currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    nextBillingDate: new Date('2026-09-01T00:00:00.000Z'),
    cancelledAt: null,
    accessEndsAt: null,
    retryCount: 0,
    ...over,
  })

  it('sobre una baja PENDIENTE corre también la fecha de fin de acceso', async () => {
    const sub = fila({
      cancelledAt: new Date('2026-08-20T00:00:00.000Z'),
      accessEndsAt: new Date('2026-09-01T00:00:00.000Z'),
      autoRenew: false,
    })
    subscriptionWriteRepo.findOne.mockResolvedValue(sub)

    await controller.extendSubscription('sub-1', { days: 10 })

    expect(sub.currentPeriodEnd.toISOString()).toBe('2026-09-11T00:00:00.000Z')
    // Lo que la marca REALMENTE gana: el acceso corre los mismos 10 días.
    expect(sub.accessEndsAt.toISOString()).toBe('2026-09-11T00:00:00.000Z')
    expect(subscriptionWriteRepo.save).toHaveBeenCalledWith(sub)
  })

  it('sin baja pendiente la columna sigue nula: extender no inventa una fecha de corte', async () => {
    const sub = fila()
    subscriptionWriteRepo.findOne.mockResolvedValue(sub)

    await controller.extendSubscription('sub-1', { days: 10 })

    expect(sub.currentPeriodEnd.toISOString()).toBe('2026-09-11T00:00:00.000Z')
    // Escribirla acá afirmaría una baja que nadie pidió y haría a la fila elegible
    // para el cron de retiro.
    expect(sub.accessEndsAt).toBeNull()
  })
})
