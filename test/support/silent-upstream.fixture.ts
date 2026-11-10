import { createServer } from 'http'
import { AddressInfo } from 'net'

export interface SilentUpstream {
  url: string
  hits: number
  close: () => Promise<void>
}

/**
 * Local HTTP server that accepts every request and never answers: an upstream that is up and
 * stalled. Not a double, the caller's real `fetch` waits on it until its own timeout.
 */
export async function startSilentUpstream(): Promise<SilentUpstream> {
  const server = createServer(() => {
    upstream.hits++
  })
  const upstream: SilentUpstream = {
    url: '',
    hits: 0,
    close: () =>
      new Promise((resolve) => {
        // The held requests would keep close() waiting forever.
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  upstream.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return upstream
}
