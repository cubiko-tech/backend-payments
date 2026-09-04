import { MetricsService } from './metrics.service'

/**
 * Candado sobre los criterios de ESTADO de las métricas: qué fila cuenta como marca
 * paga y cuál como cliente con vida útil.
 *
 * Estos métodos no tienen otra superficie observable que su SQL: cuentan y promedian
 * filas con `readDataSource.query` sobre SQL crudo y devuelven un número, así que un
 * mock que responda `0` pasaría igual con cualquier criterio. Por eso los casos
 * assertean sobre el LITERAL de la consulta capturada. Es el techo de lo que se puede
 * fijar acá, y está declarado a propósito: lo que se protege es la lista de estados,
 * no el número.
 *
 * Los dos casos exigen la MISMA forma —enumerar— y no un estado puntual: lo que se
 * defiende es que ningún filtro de estas métricas vuelva a ser negativo, porque un
 * `!=` absorbe en silencio cada estado que se agregue al enum.
 */
describe('MetricsService — criterios de estado', () => {
  const construir = () => {
    const query = jest.fn().mockResolvedValue([{ count: '0' }])
    const service = new MetricsService(
      {} as any, // snapshotRepo
      {} as any, // snapshotReadRepo
      { query } as any, // readDataSource
      {} as any, // clientRoles
    )

    return { service, query }
  }

  // MUTACIÓN QUE LO PONE ROJO: agregar `'pending'` al `IN` de esa consulta ⇒ las altas
  // que abrieron el link y nunca lo aceptaron cuentan como convertidas y la tasa
  // free→paid se infla con suscripciones que no pagaron un peso.
  it('la conversión free→paid exige `active`/`trial` y no cuenta `pending`', async () => {
    const { service, query } = construir()

    await service.getConversion()

    const sql = query.mock.calls.map(([q]) => String(q)).join('\n')
    const consultaDePagas = query.mock.calls
      .map(([q]) => String(q))
      .find((q) => q.includes(`"planSlug" != 'free'`))

    expect(consultaDePagas).toBeDefined()
    expect(consultaDePagas).toContain(`status IN ('active', 'trial')`)
    expect(sql).not.toContain('pending')
  })

  // El LTV mide vida útil de CLIENTE, y su criterio también tiene que ser una lista
  // cerrada: con el filtro negativo original (`status != 'trial'`) `pending` entraba
  // solo y las altas que nunca aceptaron su link contaban como clientes con vida útil,
  // promediando hacia abajo el `avg_days_active` de cada plan.
  //
  // MUTACIÓN QUE LO PONE ROJO: volver el `WHERE` a `s.status != 'trial'` ⇒ ya no hay
  // enumeración y `pending` vuelve a colarse.
  it('el LTV enumera los estados que promedia y deja `pending` afuera', async () => {
    const { service, query } = construir()

    await service.getLTV()

    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain(`s.status IN ('active', 'past_due', 'cancelled', 'expired')`)
    expect(sql).not.toContain('pending')
    expect(sql).not.toContain(`!=`)
  })
})
