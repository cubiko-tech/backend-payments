import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'

import { CreateActivationRequestDto } from './create-activation-request.dto'

const base = { fullName: 'Juan Pérez', email: 'juan@acme.co' }

function errorsFor(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(CreateActivationRequestDto, payload)
  return validateSync(dto).map((e) => e.property)
}

describe('CreateActivationRequestDto', () => {
  describe('phone', () => {
    // El happy path: tal como lo escribe el usuario en el formulario.
    it.each(['+57 300 123 4567', '+573001234567', '3001234567', '(300) 123-4567'])(
      'acepta el formato común "%s"',
      (phone) => {
        expect(errorsFor({ ...base, phone })).not.toContain('phone')
      },
    )

    it.each(['', 'abc', '12345', '300-abc-4567', '          '])(
      'rechaza el valor inválido "%s"',
      (phone) => {
        expect(errorsFor({ ...base, phone })).toContain('phone')
      },
    )
  })

  it('rechaza email inválido', () => {
    expect(errorsFor({ ...base, email: 'no-es-email', phone: '3001234567' })).toContain('email')
  })

  it('rechaza fullName demasiado corto', () => {
    expect(errorsFor({ ...base, fullName: 'ab', phone: '3001234567' })).toContain('fullName')
  })
})
