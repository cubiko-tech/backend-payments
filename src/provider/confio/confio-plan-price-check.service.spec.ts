import { MODULE_METADATA } from '@nestjs/common/constants'
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule'
import { Test, TestingModule } from '@nestjs/testing'
import { ConfioPlanPriceCheckService } from './confio-plan-price-check.service'
import { ConfioPlanService } from './confio-plan.service'
import { ClientRolesService } from '../../client/client-roles.service'
import { ConfioSubscriptionPlan } from '../entities/confioSubscriptionPlan.entity'
import { PaymentModule } from '../../payment/payment.module'
import { CheckoutService } from '../../checkout/checkout.service'
import { ConfioTrialService } from '../../subscription/confio-trial.service'
import { SubscriptionService } from '../../subscription/subscription.service'
import { logger } from '../../shared/logger/logger'

jest.mock('../../shared/logger/logger', () => ({
  logger: { log: jest.fn() },
}))

const loggerLog = logger.log as unknown as jest.Mock

/** Los mensajes de nivel `error` emitidos, que es por donde se reporta la divergencia. */
const errores = () => loggerLog.mock.calls.filter(([nivel]) => nivel === 'error').map(([, msg]) => msg)

/**
 * Fila sembrada, con los montos REALES de las migraciones `1787670464952` y
 * `1788532576741`: COP 19.900 → 1990000 centavos, USD 6,99 → 699 centavos.
 */
const row = (over: Partial<ConfioSubscriptionPlan> = {}): ConfioSubscriptionPlan =>
  ({
    id: 'row-1',
    planSlug: 'dropi-roax',
    currencyCode: 'COP',
    displayName: 'ROAX Pro (Dropi) - Mensual COP',
    amountCents: 1990000,
    confioName: 'stores/01STORE/subscription-plans/01PLAN',
    status: 'active',
    withTrial: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as ConfioSubscriptionPlan

const filaUsd = (over: Partial<ConfioSubscriptionPlan> = {}) =>
  row({
    id: 'row-usd',
    currencyCode: 'USD',
    amountCents: 699,
    displayName: 'ROAX Pro (Dropi) - Mensual USD',
    confioName: 'stores/01STORE/subscription-plans/01PLANUSD',
    ...over,
  })

describe('ConfioPlanPriceCheckService', () => {
  let service: ConfioPlanPriceCheckService
  let planes: { findAllMappings: jest.Mock }
  let clientRoles: { getPlanPrice: jest.Mock }
  let fetchSpy: jest.SpyInstance

  beforeEach(async () => {
    loggerLog.mockClear()
    planes = { findAllMappings: jest.fn().mockResolvedValue([]) }
    clientRoles = { getPlanPrice: jest.fn().mockResolvedValue(null) }

    // Toda la salida hacia ConfioPagos del servicio pasa por `fetch`
    // (`confio.provider.ts:114`), así que espiarlo cubre cualquier alta,
    // actualización o borrado que alguien le agregue al chequeo.
    fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation((() =>
      Promise.reject(new Error('el chequeo de precios no debe salir a la red'))) as never)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfioPlanPriceCheckService,
        { provide: ConfioPlanService, useValue: planes },
        { provide: ClientRolesService, useValue: clientRoles },
      ],
    }).compile()

    service = module.get<ConfioPlanPriceCheckService>(ConfioPlanPriceCheckService)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  /**
   * MUTACIÓN 1 de R15, mitad «sin convertir»: con los montos sembrados de verdad
   * —COP 19.900 → 1990000 y USD 6,99 → 699— comparar el precio crudo contra
   * `amountCents` marca las dos filas. La otra mitad, «truncar en vez de
   * redondear», NO la mata este caso y va en el que sigue.
   */
  it('[R15] no reporta nada cuando el catálogo coincide, convirtiendo con REDONDEO', async () => {
    planes.findAllMappings.mockResolvedValue([row(), filaUsd()])
    clientRoles.getPlanPrice.mockImplementation((_slug: string, moneda: string) =>
      Promise.resolve(moneda === 'COP' ? 19900 : 6.99),
    )

    await service.verificarPreciosContraElCatalogo()

    expect(errores()).toEqual([])
    expect(clientRoles.getPlanPrice).toHaveBeenCalledWith('dropi-roax', 'COP')
    expect(clientRoles.getPlanPrice).toHaveBeenCalledWith('dropi-roax', 'USD')
  })

  /**
   * [edge] El caso de arriba NO alcanza para la mitad «con redondeo» de la
   * mutación 1: `Math.trunc(6.99 * 100)` da 699, igual que redondear, así que
   * con 6,99 truncar se queda en verde. El precio que sí distingue las dos
   * implementaciones es uno cuyo producto por 100 cae por debajo del entero en
   * IEEE-754, como 19,99 → `1998.9999999999998`: truncar ahí da 1998 y reporta
   * una divergencia que no existe.
   */
  it('[R15] convierte con redondeo un precio que truncado daría un centavo de menos', async () => {
    planes.findAllMappings.mockResolvedValue([filaUsd({ amountCents: 1999 })])
    clientRoles.getPlanPrice.mockResolvedValue(19.99)

    await service.verificarPreciosContraElCatalogo()

    expect(errores()).toEqual([])
  })

  it('reporta en nivel error la fila cuyo amountCents se separó del catálogo, nombrándola entera', async () => {
    planes.findAllMappings.mockResolvedValue([row()])
    clientRoles.getPlanPrice.mockResolvedValue(24900)

    await service.verificarPreciosContraElCatalogo()

    const [mensaje, ...resto] = errores()
    expect(resto).toEqual([])
    expect(mensaje).toContain('dropi-roax')
    expect(mensaje).toContain('COP')
    // La variante entra en el mensaje porque las dos filas de una moneda llevan el
    // mismo precio: sin ella no se sabe cuál de los dos planes hay que recrear.
    expect(mensaje).toContain('con prueba')
    expect(mensaje).toContain('stores/01STORE/subscription-plans/01PLAN')
    expect(mensaje).toContain('1990000')
    expect(mensaje).toContain('2490000')
  })

  /**
   * [agregado] La otra mitad de la mutación 3: filtrar de más. Producción tiene
   * CUATRO filas —dos monedas × dos variantes `withTrial`— y las dos variantes de
   * una moneda comparan contra el MISMO precio del catálogo, porque la prueba
   * cambia de plan en ConfioPagos, no de monto (`getPlanPrice` está keyed por
   * `(planSlug, currency)`, sin `withTrial`).
   *
   * Ningún otro caso siembra la variante `withTrial: false` COMPARABLE —activa y
   * con `confioName`—: la única que aparece está `archived`, donde el filtro la
   * omite por otro motivo. Sin este caso, un `if (!fila.withTrial) { omitidas++;
   * continue }` deja de chequear la mitad de las filas de producción y la suite
   * entera se queda en verde.
   */
  it('[R15] compara las dos variantes withTrial de una moneda contra el mismo precio', async () => {
    planes.findAllMappings.mockResolvedValue([
      row({ id: 'cop-con', withTrial: true, confioName: 'stores/01STORE/subscription-plans/01CONPRUEBA' }),
      row({ id: 'cop-sin', withTrial: false, confioName: 'stores/01STORE/subscription-plans/01SINPRUEBA' }),
    ])
    clientRoles.getPlanPrice.mockResolvedValue(24900)

    await service.verificarPreciosContraElCatalogo()

    // El precio se pide UNA vez por fila y con la misma clave: mismo catálogo para
    // las dos variantes. Si alguna vez se buscara un precio por variante, esto cambia.
    expect(clientRoles.getPlanPrice.mock.calls).toEqual([
      ['dropi-roax', 'COP'],
      ['dropi-roax', 'COP'],
    ])

    // Y las dos divergen contra ese mismo precio: la que tiene prueba y la que no.
    const mensajes = errores()
    expect(mensajes).toHaveLength(2)
    const conPrueba = mensajes.find((m: string) => m.includes('01CONPRUEBA'))
    const sinPrueba = mensajes.find((m: string) => m.includes('01SINPRUEBA'))
    expect(conPrueba).toContain('con prueba')
    expect(sinPrueba).toContain('sin prueba')
    expect(conPrueba).toContain('2490000')
    expect(sinPrueba).toContain('2490000')
  })

  /**
   * La divergencia se REPORTA, no se arregla: crear un plan en ConfioPagos es
   * irreversible (verificado contra su API el 2026-09-04: `PATCH`/`PUT`/`DELETE`
   * sobre un plan que responde `GET 200` dan los tres 404) y no puede ser el
   * efecto colateral de un chequeo. MUTACIÓN 2 de R15.
   */
  it('[R15] no crea ni modifica nada en ConfioPagos: el chequeo no sale a la red', async () => {
    planes.findAllMappings.mockResolvedValue([row(), filaUsd()])
    clientRoles.getPlanPrice.mockResolvedValue(24900)

    await service.verificarPreciosContraElCatalogo()

    expect(errores().length).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    // Y tampoco escribe la fila local: la única puerta que se le da es de lectura.
    expect(Object.keys(planes)).toEqual(['findAllMappings'])
  })

  /**
   * MUTACIÓN 3 de R15. Sin plan del otro lado no hay con qué comparar, y hoy ese
   * es el estado de las cuatro filas de producción: quitarle el filtro al chequeo
   * las reportaría todas como divergentes.
   */
  it('[R15] no reporta filas pending, archivadas ni sin confioName: no hay plan con el que comparar', async () => {
    planes.findAllMappings.mockResolvedValue([
      row({ id: 'a', status: 'pending', confioName: null }),
      row({ id: 'b', currencyCode: 'USD', status: 'active', confioName: null, amountCents: 699 }),
      row({ id: 'c', withTrial: false, status: 'archived' }),
    ])
    clientRoles.getPlanPrice.mockResolvedValue(24900)

    await service.verificarPreciosContraElCatalogo()

    expect(errores()).toEqual([])
    expect(clientRoles.getPlanPrice).not.toHaveBeenCalled()
  })

  /**
   * MUTACIÓN 4 de R15. `getPlanRows` degrada a caché vencido o a `Map` vacío
   * cuando backend-roles falla, y `getPlanPrice` sobre ese vacío devuelve `null`.
   * Leer ese `null` como «precio 0» marcaría las cuatro filas de golpe: un fallo
   * del canal no es un hecho sobre el objeto.
   */
  it('[R15] con backend-roles caído (catálogo vacío) no reporta ninguna divergencia', async () => {
    planes.findAllMappings.mockResolvedValue([row(), filaUsd()])
    clientRoles.getPlanPrice.mockResolvedValue(null)

    await service.verificarPreciosContraElCatalogo()

    expect(errores()).toEqual([])
  })

  /**
   * [agregado] El `0` que `getAllPlanPrices` fabrica para `free` sin filas
   * (`client-roles.service.ts:99`) tampoco es precio del catálogo. La fila de
   * `free` no llega a preguntarse el precio.
   */
  it('[agregado] omite el plan free, cuyo precio 0 lo fabrica getAllPlanPrices', async () => {
    planes.findAllMappings.mockResolvedValue([row({ planSlug: 'free', amountCents: 1990000 })])

    await service.verificarPreciosContraElCatalogo()

    expect(errores()).toEqual([])
    expect(clientRoles.getPlanPrice).not.toHaveBeenCalled()
  })

  /**
   * [agregado] Una caída de la lectura no puede leerse como un descuadre de precio
   * ni tumbar el scheduler: mensaje DISTINTO y sin propagar (precedente
   * `MetricsCron`).
   */
  it('[agregado] una caída de la lectura se reporta con un mensaje distinto y no propaga', async () => {
    planes.findAllMappings.mockRejectedValue(new Error('connection terminated'))

    await expect(service.verificarPreciosContraElCatalogo()).resolves.toBeUndefined()

    const [mensaje] = errores()
    expect(mensaje).toContain('connection terminated')
    expect(mensaje).not.toContain('DIVERGENCIA')
  })

  /** [agregado] El cierre deja el conteo de la pasada, aunque no haya divergencias. */
  it('[agregado] cierra la pasada con el conteo en nivel info', async () => {
    planes.findAllMappings.mockResolvedValue([row(), row({ id: 'x', status: 'pending', confioName: null })])
    clientRoles.getPlanPrice.mockResolvedValue(19900)

    await service.verificarPreciosContraElCatalogo()

    const infos = loggerLog.mock.calls.filter(([nivel]) => nivel === 'info').map(([, msg]) => msg)
    expect(infos.some((m: string) => /1 comparadas/.test(m) && /0 divergentes/.test(m))).toBe(true)
  })
})

/**
 * MUTACIÓN 5 de R15, la mitad «corriendo desde el camino de producción» de la
 * aceptación: los casos de arriba construyen la clase con `Test.createTestingModule`
 * y llaman el método a mano, así que ninguno se pone rojo si el chequeo deja de
 * estar CABLEADO. Borrar el `@Cron` o sacar el provider de `PaymentModule` deja
 * toda la suite en verde y devuelve el servicio exactamente al defecto que esta
 * tarea cierra: nadie avisa, y nadie se entera de que nadie avisa.
 *
 * Mismo molde que `shared/auth/controllers-guarded.spec.ts`, que asserta el
 * cableado de producción por metadata justamente porque «se lee como programado
 * y no lo programa nadie» no deja rastro en una revisión de código.
 */
describe('el chequeo está cableado al scheduler y al módulo', () => {
  /**
   * Mutación A: borrar `@Cron('0 6 * * *')` del método → este caso se pone rojo,
   * porque el explorer de `@nestjs/schedule` no encuentra qué registrar y la
   * registry queda vacía. No se lee la metadata a mano: se corre el explorer de
   * verdad —`ScheduleModule.forRoot()` + `module.init()`— que es lo que la
   * aplicación hace al arrancar (`app.module.ts` ya lo importa).
   */
  it('[R15] el scheduler registra el chequeo a las 6am y el tick llega al método', async () => {
    const planes = { findAllMappings: jest.fn().mockResolvedValue([]) }
    const clientRoles = { getPlanPrice: jest.fn().mockResolvedValue(null) }

    const module: TestingModule = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ConfioPlanPriceCheckService,
        { provide: ConfioPlanService, useValue: planes },
        { provide: ClientRolesService, useValue: clientRoles },
      ],
    }).compile()

    // `init()` es lo que dispara el explorer sobre los providers: sin él no hay
    // job registrado ni con `@Cron` ni sin él, y el caso no diría nada.
    await module.init()

    try {
      const jobs = [...module.get(SchedulerRegistry).getCronJobs().values()]

      expect(jobs).toHaveLength(1)
      expect(jobs[0].cronTime.source).toBe('0 6 * * *')

      // Y que el job apunte a ESTE método y no a otro: `fireOnTick` es
      // fire-and-forget, así que hay que dejar correr los microtasks antes de mirar.
      jobs[0].fireOnTick()
      await new Promise((resolve) => setImmediate(resolve))
      expect(planes.findAllMappings).toHaveBeenCalled()
    } finally {
      // Los jobs quedan andando: sin cerrar el módulo el timer sobrevive al caso.
      await module.close()
    }
  })

  /**
   * Mutación B: sacar `ConfioPlanPriceCheckService` de `providers` en
   * `payment.module.ts` → este caso se pone rojo. Sin esa línea Nest nunca
   * instancia la clase, el explorer no la ve y el cron no existe en la
   * aplicación real, por más que el decorador siga escrito.
   */
  it('[R15] PaymentModule declara el chequeo como provider: si no, no lo instancia nadie', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentModule) ??
      []) as unknown[]

    expect(providers).toContain(ConfioPlanPriceCheckService)
  })
})

/**
 * La otra mitad de la aceptación: «no altera el alta — ninguna alta se rechaza, se
 * demora ni cambia de precio por el resultado del chequeo».
 *
 * Hoy eso se cumple por CONSTRUCCIÓN: el chequeo no está en los `exports` de
 * `PaymentModule` y ningún servicio del alta lo recibe, así que no hay camino por el
 * que su resultado llegue a una suscripción. Pero eso lo ve un revisor mirando el
 * diff, no una prueba: cablearlo dentro del alta más adelante —«ya que estamos,
 * validemos el precio antes de cobrar»— no ponía rojo ningún caso, y ahí una lectura
 * de backend-roles caída empieza a rechazar altas.
 *
 * Los dos casos cierran las dos únicas puertas de entrada de Nest: el chequeo no sale
 * del módulo, y adentro nadie del alta lo pide por constructor.
 */
describe('el chequeo no altera el alta: nadie del camino de alta lo recibe', () => {
  /**
   * Mutación C: agregar `ConfioPlanPriceCheckService` a los `exports` de
   * `payment.module.ts` → rojo. `CheckoutModule` y `SubscriptionModule` importan
   * `PaymentModule`, así que exportarlo es exactamente lo que habilita a inyectarlo
   * en el alta; mientras no esté, no hay forma de pedirlo desde allá.
   */
  it('[R15] PaymentModule no lo exporta: fuera del módulo nadie lo puede inyectar', () => {
    const exportados = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PaymentModule) ?? []) as unknown[]

    expect(exportados).not.toContain(ConfioPlanPriceCheckService)
    // Y sigue siendo provider, para que este caso no pase por la razón equivocada
    // (borrar la clase del módulo entero también lo sacaría de `exports`).
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentModule)).toContain(
      ConfioPlanPriceCheckService,
    )
  })

  /**
   * Mutación D: agregarlo al constructor de cualquiera de los tres → rojo.
   *
   * Los tres son el camino del alta de este hito: `ConfioTrialService` la crea en
   * ConfioPagos, `SubscriptionService` la escribe acá y `CheckoutService` orquesta
   * pago → suscripción → factura. `design:paramtypes` es la lista real de lo que Nest
   * le inyecta a cada uno (`emitDecoratorMetadata` está prendido en `tsconfig.json`),
   * así que si alguno lo pide, acá se ve.
   */
  it.each([
    ['ConfioTrialService', ConfioTrialService],
    ['SubscriptionService', SubscriptionService],
    ['CheckoutService', CheckoutService],
  ])('[R15] %s no recibe el chequeo por constructor', (_nombre, clase) => {
    const inyectados = (Reflect.getMetadata('design:paramtypes', clase) ?? []) as unknown[]

    // Guarda de la guarda: si la metadata dejara de emitirse, la lista vendría vacía
    // y el `not.toContain` pasaría siempre.
    expect(inyectados.length).toBeGreaterThan(0)
    expect(inyectados).not.toContain(ConfioPlanPriceCheckService)
  })
})
