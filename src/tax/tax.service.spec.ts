import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'

import { TaxService } from './tax.service'
import { TaxConfig } from './entities/taxConfig.entity'

/**
 * El impuesto es plata: lo que se fija acá es que un país sin configuración **no** caiga
 * en silencio al 19% colombiano, y que la búsqueda no falle por un espacio.
 *
 * Censo de `tax_config` al 2026-09-01 (base local): `CO` 19%, `MX` 16%, `US` 0%
 * («Sales tax»), las tres activas. O sea que los países del catálogo YA tienen fila y la
 * rama de 0% cubre a los que no.
 */
describe('TaxService', () => {
  let service: TaxService
  let repo: { findOne: jest.Mock }

  beforeEach(async () => {
    repo = { findOne: jest.fn().mockResolvedValue(null) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [TaxService, { provide: getRepositoryToken(TaxConfig, 'DBRead'), useValue: repo }],
    }).compile()

    service = module.get<TaxService>(TaxService)
  })

  it('normaliza el país antes de buscarlo', async () => {
    // Mutación: sacar el `trim()` (o el `toUpperCase()`) — la fila no matchea y la marca
    // pasa a pagar 0% sin que nadie se entere. El país llega de tres fuentes distintas
    // (catálogo, perfil de facturación, metadata del pago), así que el espacio es real.
    repo.findOne.mockResolvedValue({ taxName: 'IVA', taxRate: '0.1900', isInclusive: false })

    await service.getTaxForCountry(' co ')

    expect(repo.findOne).toHaveBeenCalledWith({ where: { country: 'CO', isActive: true } })
  })

  it('un país sin configuración no lleva impuesto, y lo dice en el log', async () => {
    // Mutación: devolver la fila colombiana como default — una marca de un país sin
    // configurar pagaría 19% ajeno. Es la condición 2 de la aceptación.
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined)

    const tax = await service.getTaxForCountry('AR')

    expect(tax).toEqual({ taxName: 'N/A', taxRate: 0, isInclusive: false })
    expect(warn).toHaveBeenCalled()
  })

  it('un fallo al leer la tabla no rompe el checkout: 0% y error logueado', async () => {
    // Mutación: relanzar el error en vez de devolver 0% — `POST /checkout`, que mueve
    // plata, pasaría a responder 5xx por una lectura de configuración. Es la variante que
    // el crítico rechazó el 2026-09-01 y que esta prueba deja fijada como NO deseada.
    repo.findOne.mockRejectedValue(new Error('conexión caída'))
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)

    const tax = await service.getTaxForCountry('CO')

    expect(tax).toEqual({ taxName: 'N/A', taxRate: 0, isInclusive: false })
    expect(error).toHaveBeenCalled()
  })
})
