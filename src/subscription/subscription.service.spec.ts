import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm'
import { SubscriptionService } from './subscription.service'
import { Subscription, SubscriptionStatus } from './entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from './entities/subscriptionEvent.entity'
import { ClientRolesService } from '../client/client-roles.service'
import { EventBusService } from '../event-bus/event-bus.service'
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
  let clientRoles: { assignPlanToBrand: jest.Mock; removePlanFromBrand: jest.Mock; renewPlanForBrand: jest.Mock }

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
        {
          provide: EventBusService,
          useValue: { publishNotification: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile()

    service = module.get<SubscriptionService>(SubscriptionService)
    clientRoles = module.get(ClientRolesService)
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

  describe('startTrial', () => {
    it('crea un trial de 15 días, asigna el plan en roles y registra el evento', async () => {
      subscriptionRepo.findOne.mockResolvedValue(null)
      subscriptionRepo.create.mockImplementation((data) => data)
      subscriptionRepo.save.mockImplementation((data) => Promise.resolve({ id: 'sub-1', ...data }))
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' })

      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(result.data.trialStart).toBeInstanceOf(Date)
      expect(result.data.trialEnd).toBeInstanceOf(Date)
      // nextBillingDate = trialEnd para que el cron de conversión lo tome
      expect(result.data.nextBillingDate).toEqual(result.data.trialEnd)
      // ~15 días de trial
      const days = Math.round(
        (result.data.trialEnd.getTime() - result.data.trialStart.getTime()) / (24 * 3600 * 1000),
      )
      expect(days).toBe(15)

      // plan asignado en roles con expiración = fin del trial
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('brand-1', 'pro', result.data.trialEnd)

      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.TRIAL_STARTED,
        toPlanSlug: 'pro',
        toStatus: SubscriptionStatus.TRIAL,
        triggeredBy: 'user-1',
      }))
    })

    it('rechaza si la marca ya tiene una suscripción vigente', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.ACTIVE,
        trialStart: null,
      })

      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' }),
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' })
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('rechaza una suscripción en mora como vigente, no como prueba consumida', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.PAST_DUE,
        trialStart: new Date('2026-01-01'),
      })

      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' }),
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' })
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    })

    it('rechaza si la marca ya consumió su prueba', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: new Date('2026-01-01'),
        trialEnd: new Date('2026-01-16'),
      })

      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' }),
      ).rejects.toMatchObject({ code: 'TRIAL_ALREADY_USED' })
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('reinicia la prueba sobre una suscripción cancelada que nunca la usó', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.CANCELLED,
        trialStart: null,
        cancelledAt: new Date('2026-02-01'),
        cancelReason: 'motivo',
        retryCount: 3,
        lastPaymentId: 'pay-1',
      })
      subscriptionRepo.create.mockImplementation((data) => data)
      subscriptionRepo.save.mockImplementation((data) => Promise.resolve({ ...data }))
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.startTrial({
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'pro',
      })

      // Reusa la fila existente: el índice único por brandId impide una segunda.
      expect(subscriptionRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'sub-1',
        status: SubscriptionStatus.TRIAL,
        cancelledAt: null,
        cancelReason: null,
        retryCount: 0,
        lastPaymentId: null,
      }))
      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('brand-1', 'pro', result.data.trialEnd)
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: SubscriptionEventType.TRIAL_STARTED,
        fromStatus: SubscriptionStatus.CANCELLED,
        toStatus: SubscriptionStatus.TRIAL,
      }))
    })

    it('permite la prueba sobre una suscripción vencida que nunca la usó', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: null,
      })
      subscriptionRepo.create.mockImplementation((data) => data)
      subscriptionRepo.save.mockImplementation((data) => Promise.resolve({ ...data }))
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.startTrial({
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'pro',
      })

      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(subscriptionRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1' }))
    })

    it('rechaza iniciar un trial con el plan free', async () => {
      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'free' }),
      ).rejects.toThrow(RequestException)
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
