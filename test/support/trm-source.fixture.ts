import { createServer, Server } from 'http'
import { AddressInfo } from 'net'

import { bogotaDay } from '../../src/trm/trm.service'
import type { Gate } from './wallet-race.fixture'

export type TrmReply = { status: number; body: unknown }

const DAY_MS = 24 * 60 * 60 * 1000

/** Today in Bogota when the suite loads: the day the default row is in force. */
export const TRM_DAY = bogotaDay(Date.now())
/** `days` after `TRM_DAY` (negative, before), `YYYY-MM-DD`. */
export const trmDayPlus = (days: number) =>
  new Date(Date.parse(`${TRM_DAY}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

/** A source row in force from `since` to `until`, both inclusive, as datos.gov.co sends it. */
export const trmRow = (valor: string, since: string, until = since) => ({
  valor,
  vigenciadesde: `${since}T00:00:00.000`,
  vigenciahasta: `${until}T00:00:00.000`,
})

// Valid until tomorrow, like a weekend row: a suite running across midnight still finds it in force.
export const TRM_ROW = trmRow('4000.00', TRM_DAY, trmDayPlus(1))
export const trmOk = (): TrmReply => ({ status: 200, body: [TRM_ROW] })
export const trmDown = (): TrmReply => ({ status: 500, body: { error: 'boom' } })

export interface TrmSource {
  url: string
  hits: number
  /** Path and query of the last request, as the service sent it. */
  lastQuery: string
  reply: () => TrmReply
  /** When set, a request arrives at it and the answer waits for its release. */
  gate?: Gate
  close: () => Promise<void>
}

/**
 * Local HTTP server standing in for datos.gov.co: not a double, the service's real `fetch`
 * hits a controlled edge. It ignores the query and answers `reply`, so a case can send rows the
 * real filter would drop. `hits` counts requests; change `reply` to switch its answer.
 */
export async function startTrmSource(reply: () => TrmReply = trmOk): Promise<TrmSource> {
  let server: Server
  const source: TrmSource = {
    url: '',
    hits: 0,
    lastQuery: '',
    reply,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  server = createServer(async (req, res) => {
    source.hits++
    source.lastQuery = req.url ?? ''
    if (source.gate) {
      source.gate.arrive()
      await source.gate.wait
    }
    const { status, body } = source.reply()
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  source.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/trm.json`
  return source
}
