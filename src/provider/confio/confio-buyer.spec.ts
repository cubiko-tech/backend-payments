import { ConfioSubscriptionInputError } from './confio-subscription-error'
import {
  assertConfioBuyer,
  buildConfioBuyer,
  resolveConfioBuyer,
  ConfioBuyerSource,
} from './confio-buyer'

/**
 * El helper es PURO: no toca la red, ni Nest, ni `process.env`. Así que no hay
 * nada que falsear — se lo llama directo, como a `confio-webhook-signature.ts`.
 */

/** Fuente mínima válida, con la forma REAL de `GET $SERVICE_AUTH/user/{id}`. */
const source = (over: Partial<ConfioBuyerSource> = {}): ConfioBuyerSource => ({
  email: 'usuario@roaxai.com',
  name: 'Ana Perez',
  phone: '+573001234567',
  callingCode: '57',
  ...over,
})

/**
 * Captura el rechazo con su tipo. Un `.catch((e) => e)` deja una unión con el
 * valor resuelto y esconde `code`/`field`. Mismo molde que `confio.provider.spec.ts`.
 */
const rechazo = (fn: () => unknown): ConfioSubscriptionInputError => {
  try {
    fn()
  } catch (e) {
    return e as ConfioSubscriptionInputError
  }
  throw new Error('se esperaba un rechazo y la llamada devolvió')
}

describe('buildConfioBuyer — teléfono a E.164', () => {
  it('deja intacto un teléfono que ya viene en E.164 estricto', () => {
    expect(buildConfioBuyer(source({ phone: '+573001234567' })).phoneNumber).toBe('+573001234567')
  })

  it('limpia espacios, guiones, paréntesis y puntos conservando el +', () => {
    expect(buildConfioBuyer(source({ phone: '+57 (300) 123-45.67' })).phoneNumber).toBe(
      '+573001234567',
    )
  })

  it('compone + callingCode + número cuando el teléfono es local', () => {
    expect(buildConfioBuyer(source({ phone: '3001234567', callingCode: '57' })).phoneNumber).toBe(
      '+573001234567',
    )
  })

  it('descarta los ceros iniciales del prefijo troncal nacional', () => {
    expect(buildConfioBuyer(source({ phone: '03001234567', callingCode: '57' })).phoneNumber).toBe(
      '+573001234567',
    )
  })

  it('normaliza un callingCode con +, espacios y guiones', () => {
    expect(buildConfioBuyer(source({ phone: '3001234567', callingCode: '+5 7' })).phoneNumber).toBe(
      '+573001234567',
    )
  })

  it('no duplica el código de país si los dígitos ya lo traen', () => {
    expect(buildConfioBuyer(source({ phone: '573001234567', callingCode: '57' })).phoneNumber).toBe(
      '+573001234567',
    )
  })

  it('rechaza un teléfono local sin callingCode, sin inventar país', () => {
    const err = rechazo(() => buildConfioBuyer(source({ phone: '3001234567', callingCode: '' })))

    expect(err).toBeInstanceOf(ConfioSubscriptionInputError)
    expect(err.code).toBe('invalid_buyer')
    expect(err.field).toBe('buyer.phoneNumber')
    // El fallback silencioso de `normalizeColombianPhone` queda PROHIBIDO acá.
    expect(err.message).not.toContain('+573215786325')
  })

  it('rechaza un callingCode que no es un código de país', () => {
    const err = rechazo(() => buildConfioBuyer(source({ phone: '3001234567', callingCode: 'CO' })))

    expect(err.code).toBe('invalid_buyer')
    expect(err.field).toBe('buyer.phoneNumber')
  })

  it('rechaza un teléfono vacío', () => {
    const err = rechazo(() => buildConfioBuyer(source({ phone: '' })))

    expect(err.field).toBe('buyer.phoneNumber')
  })

  it('rechaza un número demasiado corto para E.164 aun componiendo el país', () => {
    const err = rechazo(() => buildConfioBuyer(source({ phone: '123', callingCode: '57' })))

    expect(err.field).toBe('buyer.phoneNumber')
  })
})

describe('buildConfioBuyer — nombre a firstName/lastName', () => {
  it('parte un nombre de dos palabras', () => {
    const buyer = buildConfioBuyer(source({ name: 'Ana Perez' }))

    expect(buyer.firstName).toBe('Ana')
    expect(buyer.lastName).toBe('Perez')
  })

  it('con tres o más palabras, la primera es firstName y el resto lastName', () => {
    const buyer = buildConfioBuyer(source({ name: 'Ana Maria Perez Gomez' }))

    expect(buyer.firstName).toBe('Ana')
    expect(buyer.lastName).toBe('Maria Perez Gomez')
  })

  it('colapsa los espacios internos múltiples', () => {
    const buyer = buildConfioBuyer(source({ name: '  Ana   Maria   Perez  ' }))

    expect(buyer.firstName).toBe('Ana')
    expect(buyer.lastName).toBe('Maria Perez')
  })

  it('replica la única palabra en lastName cuando el nombre es uno solo', () => {
    const buyer = buildConfioBuyer(source({ name: 'Madonna' }))

    expect(buyer.firstName).toBe('Madonna')
    expect(buyer.lastName).toBe('Madonna')
  })

  it('replica el nombre en lastName cuando el apellido queda de menos de 3', () => {
    const buyer = buildConfioBuyer(source({ name: 'Ana Li' }))

    expect(buyer.firstName).toBe('Ana')
    expect(buyer.lastName).toBe('Ana')
  })
})

describe('buildConfioBuyer — nombre derivado del email', () => {
  it('deriva el nombre cuando `name` viene NULL, el caso real de la cuenta', () => {
    const buyer = buildConfioBuyer(source({ email: 'manuel@cubiko.co', name: undefined }))

    expect(buyer.firstName).toBe('manuel')
    expect(buyer.lastName).toBe('manuel')
  })

  it.each([
    ['vacío', ''],
    ['en blanco', '   '],
    ['de 1–2 caracteres', 'Jo'],
  ])('deriva del email un nombre %s en vez de rechazar el alta', (_caso, name) => {
    const buyer = buildConfioBuyer(source({ email: 'manuel@cubiko.co', name }))

    expect(buyer.firstName).toBe('manuel')
    expect(buyer.lastName).toBe('manuel')
  })

  it('parte el email por el punto en nombre y apellido', () => {
    const buyer = buildConfioBuyer(source({ email: 'ana.perez@cubiko.co', name: null }))

    expect(buyer.firstName).toBe('ana')
    expect(buyer.lastName).toBe('perez')
  })

  it('trata guiones y guiones bajos como separadores', () => {
    expect(buildConfioBuyer(source({ email: 'ana_maria-perez@x.com', name: '' }))).toMatchObject({
      firstName: 'ana',
      lastName: 'maria perez',
    })
  })

  it('descarta el sub-address +algo, que no es parte de la identidad', () => {
    const buyer = buildConfioBuyer(source({ email: 'manuel+stg@cubiko.co', name: '' }))

    expect(buyer.firstName).toBe('manuel')
    expect(buyer.lastName).toBe('manuel')
  })

  it('replica en lastName si del email sale una sola parte usable', () => {
    const buyer = buildConfioBuyer(source({ email: 'manuel.p@cubiko.co', name: '' }))

    expect(buyer.firstName).toBe('manuel')
    expect(buyer.lastName).toBe('manuel')
  })

  it('deriva del email una parte de más de 64 caracteres, sin truncar nada', () => {
    const buyer = buildConfioBuyer(
      source({ email: 'manuel@cubiko.co', name: `${'A'.repeat(65)} Perez` }),
    )

    expect(buyer.firstName).toBe('manuel')
    expect(buyer.lastName).toBe('manuel')
  })

  it('NO mezcla perfil y email: con el nombre inservible, el apellido también sale del email', () => {
    const buyer = buildConfioBuyer(source({ email: 'manuel@cubiko.co', name: 'Jo Perez' }))

    expect(buyer.firstName).toBe('manuel')
    expect(buyer.lastName).toBe('manuel')
  })

  it('el nombre del perfil MANDA sobre el email cuando sirve', () => {
    const buyer = buildConfioBuyer(source({ email: 'manuel@cubiko.co', name: 'Ana Perez' }))

    expect(buyer.firstName).toBe('Ana')
    expect(buyer.lastName).toBe('Perez')
  })

  it('rechaza cuando el email tampoco da una parte usable, sin rellenarla', () => {
    const err = rechazo(() => buildConfioBuyer(source({ email: 'me@x.com', name: '' })))

    expect(err.code).toBe('invalid_buyer')
    expect(err.field).toBe('buyer.firstName')
    expect(err.message).toContain('me@x.com')
  })
})

describe('buildConfioBuyer — email', () => {
  it('recorta los espacios de un email válido', () => {
    expect(buildConfioBuyer(source({ email: '  usuario@roaxai.com ' })).email).toBe(
      'usuario@roaxai.com',
    )
  })

  it.each([
    ['', 'vacío'],
    ['   ', 'en blanco'],
    ['sin-arroba', 'sin @'],
  ])('rechaza un email %s (%s)', (email) => {
    const err = rechazo(() => buildConfioBuyer(source({ email })))

    expect(err.code).toBe('invalid_buyer')
    expect(err.field).toBe('buyer.email')
  })
})

describe('assertConfioBuyer — validación de borde', () => {
  const buyer = {
    email: 'usuario@roaxai.com',
    phoneNumber: '+573001234567',
    firstName: 'Ana',
    lastName: 'Perez',
  }

  it('devuelve el buyer normalizado cuando ya está bien armado', () => {
    expect(assertConfioBuyer({ ...buyer, email: ' usuario@roaxai.com ' })).toEqual(buyer)
  })

  it('rechaza un teléfono local suelto: en el borde no hay país que aportar', () => {
    const err = rechazo(() => assertConfioBuyer({ ...buyer, phoneNumber: '3001234567' }))

    expect(err.code).toBe('invalid_buyer')
    expect(err.field).toBe('buyer.phoneNumber')
    expect(err.message).not.toContain('+573215786325')
  })

  it('en el borde también deriva del email un firstName fuera de 3–64', () => {
    expect(assertConfioBuyer({ ...buyer, firstName: 'Jo' })).toEqual({
      ...buyer,
      firstName: 'usuario',
      lastName: 'usuario',
    })
  })

  it('rechaza en el borde si ni el nombre ni el email dan una parte usable', () => {
    const err = rechazo(() => assertConfioBuyer({ ...buyer, email: 'me@x.com', firstName: '' }))

    expect(err.field).toBe('buyer.firstName')
  })
})

describe('resolveConfioBuyer', () => {
  it('arma el buyer con los datos que devuelve el lookup para ese userId', async () => {
    const lookup = jest.fn().mockResolvedValue(source({ name: 'Ana Perez' }))

    const buyer = await resolveConfioBuyer({ id: 'u-1' }, lookup)

    expect(lookup).toHaveBeenCalledWith('u-1')
    expect(buyer).toEqual({
      email: 'usuario@roaxai.com',
      phoneNumber: '+573001234567',
      firstName: 'Ana',
      lastName: 'Perez',
    })
  })

  it('propaga el fallo del canal tal cual: NO lo convierte en invalid_buyer', async () => {
    const boom = new Error('USER_LOOKUP_UNAVAILABLE')
    const lookup = jest.fn().mockRejectedValue(boom)

    await expect(resolveConfioBuyer({ id: 'u-1' }, lookup)).rejects.toBe(boom)
  })
})
