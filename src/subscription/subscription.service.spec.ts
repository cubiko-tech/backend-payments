import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm'
import { SubscriptionService } from './subscription.service'
import { Subscription, SubscriptionStatus } from './entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from './entities/subscriptionEvent.entity'
import { ClientRolesService } from '../client/client-roles.service'
import { RequestException } from '../shared/exception/request.exception'

const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((data) => data),
  save: jest.fn((data) => Promise.resolve({ id: 'mock-id', ...data })),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
})

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    findOne: jest.fn(),
    save: jest.fn((entity, data) => Promise.resolve({ id: 'mock-id', ...data })),
    create: jest.fn((entity, data) => data),
  },
}

describe('SubscriptionService', () => {
  let service: SubscriptionService
  let subscriptionRepo: ReturnType<typeof createMockRepo>
  let subscriptionReadRepo: ReturnType<typeof createMockRepo>
  let eventRepo: ReturnType<typeof createMockRepo>
  let eventReadRepo: ReturnType<typeof createMockRepo>

  beforeEach(async () => {
    subscriptionRepo = createMockRepo()
    subscriptionReadRepo = createMockRepo()
    eventRepo = createMockRepo()
    eventReadRepo = createMockRepo()

    Object.values(mockQueryRunner).forEach((fn) => {
      if (typeof fn === 'function') (fn as jest.Mock).mockReset()
    })
    mockQueryRunner.manager.findOne.mockReset()
    mockQueryRunner.manager.save.mockReset().mockImplementation((entity, data) =>
      Promise.resolve({ id: 'mock-id', ...data }),
    )
    mockQueryRunner.manager.create.mockReset().mockImplementation((entity, data) => data)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subscriptionRepo },
        { provide: getRepositoryToken(Subscription, 'DBRead'), useValue: subscriptionReadRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: eventRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBRead'), useValue: eventReadRepo },
        {
          provide: getDataSourceToken('DBWrite'),
          useValue: { createQueryRunner: () => mockQueryRunner },
        },
        {
          provide: ClientRolesService,
          useValue: {
            assignPlanToBrand: jest.fn().mockResolvedValue(true),
            removePlanFromBrand: jest.fn().mockResolvedValue(true),
            renewPlanForBrand: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile()

    service = module.get<SubscriptionService>(SubscriptionService)
  })

  describe('getCurrent', () => {
    it('retorna la suscripción actual de una marca', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        planSlug: 'pro',
        status: SubscriptionStatus.ACTIVE,
      }
      subscriptionReadRepo.findOne.mockResolvedValue(subscription)

      const result = await service.getCurrent('brand-1')

      expect(result.data).toEqual(subscription)
      expect(subscriptionReadRepo.findOne).toHaveBeenCalledWith({
        where: { brandId: 'brand-1' },
      })
    })

    it('lanza error si no existe suscripción', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue(null)

      await expect(service.getCurrent('brand-1')).rejects.toThrow(RequestException)
    })
  })

  describe('create', () => {
    it('crea suscripción y registra evento de creación', async () => {
      const data = {
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'pro',
        status: SubscriptionStatus.TRIAL,
      }
      subscriptionRepo.create.mockReturnValue(data)
      subscriptionRepo.save.mockResolvedValue({ id: 'sub-1', ...data })
      eventRepo.create.mockReturnValue({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.CREATED,
      })
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.create(data)

      expect(result.data).toEqual({ id: 'sub-1', ...data })
      expect(subscriptionRepo.create).toHaveBeenCalledWith(data)
      expect(subscriptionRepo.save).toHaveBeenCalledWith(data)

      // Verifica que se registró el evento
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.CREATED,
        toPlanSlug: 'pro',
        toStatus: SubscriptionStatus.TRIAL,
        triggeredBy: 'user-1',
      }))
      expect(eventRepo.save).toHaveBeenCalled()
    })
  })

  describe('cancel', () => {
    it('cancela suscripción y registra evento', async () => {
      const subscription: any = {
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.ACTIVE,
        autoRenew: true,
        cancelledAt: null,
        cancelReason: null,
      }
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.cancel('brand-1', {
        reason: 'Ya no necesito el servicio',
        triggeredBy: 'user-1',
      })

      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED)
      expect(subscription.autoRenew).toBe(false)
      expect(subscription.cancelledAt).toBeInstanceOf(Date)
      expect(subscription.cancelReason).toBe('Ya no necesito el servicio')

      // Verifica evento de cancelación
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.CANCELLED,
        fromStatus: SubscriptionStatus.ACTIVE,
        toStatus: SubscriptionStatus.CANCELLED,
        triggeredBy: 'user-1',
        reason: 'Ya no necesito el servicio',
      }))
      expect(result.data).toBeDefined()
    })

    it('lanza error si la suscripción no existe', async () => {
      subscriptionRepo.findOne.mockResolvedValue(null)

      await expect(
        service.cancel('brand-1', { reason: 'test', triggeredBy: 'user-1' }),
      ).rejects.toThrow(RequestException)
    })
  })

  describe('reactivate', () => {
    it('reactiva una suscripción cancelada', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: 'motivo',
        autoRenew: false,
      }
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.reactivate('brand-1', 'user-1')

      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE)
      expect(subscription.cancelledAt).toBeNull()
      expect(subscription.cancelReason).toBeNull()
      expect(subscription.autoRenew).toBe(true)

      // Verifica evento de reactivación
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.REACTIVATED,
        fromStatus: SubscriptionStatus.CANCELLED,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: 'user-1',
      }))
      expect(result.data).toBeDefined()
    })

    it('lanza error si la suscripción no está cancelada', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.ACTIVE,
      }
      subscriptionRepo.findOne.mockResolvedValue(subscription)

      await expect(service.reactivate('brand-1', 'user-1')).rejects.toThrow(RequestException)
    })
  })

  describe('getHistory', () => {
    it('retorna el historial de eventos de suscripción', async () => {
      const subscription = { id: 'sub-1', brandId: 'brand-1' }
      const events = [
        { id: 'ev-1', subscriptionId: 'sub-1', eventType: SubscriptionEventType.CREATED },
        { id: 'ev-2', subscriptionId: 'sub-1', eventType: SubscriptionEventType.CANCELLED },
      ]
      subscriptionReadRepo.findOne.mockResolvedValue(subscription)
      eventReadRepo.find.mockResolvedValue(events)

      const result = await service.getHistory('brand-1')

      expect(result.data).toEqual(events)
      expect(subscriptionReadRepo.findOne).toHaveBeenCalledWith({
        where: { brandId: 'brand-1' },
      })
      expect(eventReadRepo.find).toHaveBeenCalledWith({
        where: { subscriptionId: 'sub-1' },
        order: { createdAt: 'DESC' },
      })
    })

    it('lanza error si no existe suscripción', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue(null)

      await expect(service.getHistory('brand-1')).rejects.toThrow(RequestException)
    })
  })
})
