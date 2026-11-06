import { createServer, Server } from 'http'
import { AddressInfo } from 'net'

export type TrmReply = { status: number; body: unknown }

export const TRM_ROW = { valor: '4000.00', vigenciadesde: '2026-11-06T00:00:00.000' }
export const trmOk = (): TrmReply => ({ status: 200, body: [TRM_ROW] })
export const trmDown = (): TrmReply => ({ status: 500, body: { error: 'boom' } })

export interface TrmSource {
  url: string
  hits: number
  reply: () => TrmReply
  close: () => Promise<void>
}

/**
 * Local HTTP server standing in for datos.gov.co: not a double, the service's real `fetch`
 * hits a controlled edge. `hits` counts requests; change `reply` to switch its answer.
 */
export async function startTrmSource(reply: () => TrmReply = trmOk): Promise<TrmSource> {
  let server: Server
  const source: TrmSource = {
    url: '',
    hits: 0,
    reply,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  server = createServer((_req, res) => {
    source.hits++
    const { status, body } = source.reply()
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  source.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/trm.json`
  return source
}
