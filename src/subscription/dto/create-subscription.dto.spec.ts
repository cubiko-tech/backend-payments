import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { CreateSubscriptionDto } from './create-subscription.dto'
import { SubscriptionProvider } from '../entities/subscription.entity'

/**
 * El candado del alta genérica (`POST /subscription`). Se corre el `ValidationPipe`
 * REAL con las MISMAS opciones que `main.ts` (`whitelist` + `forbidNonWhitelisted`,
 * sin `transform`) en vez de llamar a `validate()` a mano: lo que protege la fila no
 * es la clase sola, es la clase MÁS esas dos opciones, y probar sólo la mitad deja
 * pasar el día que alguien las cambie.
 */
describe('CreateSubscriptionDto — lista blanca del alta genérica', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
  const metadata = { type: 'body' as const, metatype: CreateSubscriptionDto }

  const altaValida = {
    brandId: 'brand-1',
    userId: 'user-1',
    planSlug: 'pro',
    provider: SubscriptionProvider.WALLET,
    // UUID v4 de verdad: `@IsUUID()` exige versión válida y rechaza el placeholder
    // en ceros del `.http`.
    walletId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  }

  // Mutación que lo pone rojo: declarar `id` en el DTO ⇒ el body pasa y `save()`
  // vuelve a poder UPDATEAR la fila de otra marca.
  it('rechaza un `id` en el body: sin él, `save()` sólo puede INSERTAR', async () => {
    const body = { ...altaValida, id: '11111111-1111-1111-1111-111111111111' }

    await expect(pipe.transform(body, metadata)).rejects.toThrow(BadRequestException)
  })

  // Mutación: declarar `trialStart`/`trialEnd` en el DTO ⇒ el body pasa y la marca
  // durable de prueba consumida se puede borrar por HTTP.
  it('rechaza `trialStart`/`trialEnd`: la prueba consumida no se limpia por el body', async () => {
    const body = { ...altaValida, trialStart: null, trialEnd: null }

    await expect(pipe.transform(body, metadata)).rejects.toThrow(BadRequestException)
  })

  // Los otros sellos que escriben los caminos de dominio (baja, crons, checkout) y
  // que un llamador tampoco puede fijar.
  it.each(['cancelledAt', 'accessEndsAt', 'retryCount', 'lastPaymentId'])(
    'rechaza `%s`: es un sello del dominio, no un campo del alta',
    async (campo) => {
      await expect(pipe.transform({ ...altaValida, [campo]: null }, metadata)).rejects.toThrow(
        BadRequestException,
      )
    },
  )

  // Mutación: sacarle `provider` o `walletId` al DTO ⇒ este alta legítima se cae con
  // 400 y el endpoint queda inservible. La lista blanca tiene que dejar pasar el alta.
  it('acepta el alta legítima con los campos declarados', async () => {
    const result = await pipe.transform({ ...altaValida }, metadata)

    expect(result).toEqual(expect.objectContaining(altaValida))
    expect(result).not.toHaveProperty('id')
  })
})
