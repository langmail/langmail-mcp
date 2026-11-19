// The self-hosted server's HTTP listener, on node:http so the same code runs
// under Node and Bun (Bun implements node:http). The hosted server keeps
// Bun.serve (src/index.ts): it runs from source under Bun only.
//
// It adapts a fetch-style handler, Request in and Response out, which is what
// the routes and the MCP SDK's web-standard transport speak. Response bodies
// are streamed chunk by chunk, so Streamable HTTP's server-sent events reach
// the client as they are written, and a client that disconnects aborts the
// Request's signal.

import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export type FetchHandler = (req: Request) => Promise<Response>

export interface Listener {
  port: number
  // Closes the listener and every open connection.
  stop: () => Promise<void>
}

export interface ListenOptions {
  fetch: FetchHandler
  host: string
  // Answers a request whose handler threw.
  onError: (error: unknown) => Response
  port: number
}

const toRequest = (req: IncomingMessage, signal: AbortSignal, fallbackHost: string): Request => {
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    if (name !== undefined && value !== undefined) {
      headers.append(name, value)
    }
  }
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? fallbackHost}`)
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(url.href, {
    headers,
    method,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit)
}

const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') {
      headers[name] = value
    }
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies
  }
  res.writeHead(response.status, response.statusText, headers)
  if (!response.body) {
    res.end()
    return
  }
  // Send the head now: an event stream may not write its first event for a
  // while, and the client waits for the status line.
  res.flushHeaders()
  for await (const chunk of response.body) {
    if (res.destroyed) {
      break
    }
    if (!res.write(chunk)) {
      // The listener that loses the race is removed, so a slow client does
      // not pile up listeners over a long body.
      const settled = new AbortController()
      await Promise.race([
        once(res, 'drain', { signal: settled.signal }),
        once(res, 'close', { signal: settled.signal }),
      ]).finally(() => settled.abort())
    }
  }
  res.end()
}

export const listen = async (opts: ListenOptions): Promise<Listener> => {
  const fallbackHost = `${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${opts.port}`
  const server = createServer((req, res) => {
    const aborted = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted.abort()
      }
    })
    const respond = async (): Promise<void> => {
      let response: Response
      try {
        response = await opts.fetch(toRequest(req, aborted.signal, fallbackHost))
      } catch (error) {
        response = opts.onError(error)
      }
      await writeResponse(res, response)
    }
    respond().catch(() => {
      // The client went away mid-body, or the body stream failed after the
      // head was sent: nothing is left to answer.
      res.destroy()
    })
  })

  server.listen(opts.port, opts.host)
  await Promise.race([
    once(server, 'listening'),
    once(server, 'error').then(([error]) => {
      throw error
    }),
  ])

  const { port } = server.address() as AddressInfo
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
