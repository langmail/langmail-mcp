// A fake Stalwart on loopback for the self-hosted server's tests and the
// package check (scripts/check-package.ts): a JMAP session behind Basic auth,
// and a JMAP API where every method answers "nothing here", which is enough
// for a search to run. Every method call is recorded. Built on the self-hosted
// listener, so it runs under Node and Bun.

import { listen } from '../self-hosted/listen.ts'

export interface JmapCall {
  args: Record<string, unknown>
  name: string
}

export interface FakeStalwart {
  jmapCalls: JmapCall[]
  stop: () => Promise<void>
  url: string
}

export const fakeSessionBody = (base: string) => ({
  apiUrl: `${base}/jmap/`,
  capabilities: {},
  downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  primaryAccounts: {
    'urn:ietf:params:jmap:contacts': 'acct',
    'urn:ietf:params:jmap:mail': 'acct',
    'urn:ietf:params:jmap:submission': 'acct',
  },
  uploadUrl: `${base}/jmap/upload/{accountId}/`,
  username: 'alice@example.com',
})

const emptyResponse = (args: Record<string, unknown>) => ({
  accountId: args.accountId,
  ids: [],
  list: [],
  notFound: [],
  position: 0,
  total: 0,
})

const internalError = (error: unknown): Response => new Response(String(error), { status: 500 })

export const startFakeStalwart = async (opts: { password: string; username: string }): Promise<FakeStalwart> => {
  const basic = `Basic ${btoa(`${opts.username}:${opts.password}`)}`
  const jmapCalls: JmapCall[] = []
  let url = ''
  const server = await listen({
    fetch: async (req) => {
      if (req.headers.get('authorization') !== basic) {
        return new Response('unauthorized', { status: 401 })
      }
      const { pathname } = new URL(req.url)
      if (pathname === '/.well-known/jmap') {
        return Response.json(fakeSessionBody(url))
      }
      if (pathname === '/jmap/' && req.method === 'POST') {
        const body = (await req.json()) as { methodCalls: [string, Record<string, unknown>, string][] }
        return Response.json({
          methodResponses: body.methodCalls.map(([name, args, id]) => {
            jmapCalls.push({ args, name })
            return [name, emptyResponse(args), id]
          }),
          sessionState: 's',
        })
      }
      return new Response('not found', { status: 404 })
    },
    host: '127.0.0.1',
    onError: internalError,
    port: 0,
  })
  url = `http://127.0.0.1:${server.port}`
  return { jmapCalls, stop: server.stop, url }
}

// A server that answers every request with the given JSON, e.g. a JMAP session
// that advertises its API on another host.
export const startJsonServer = (body: unknown) =>
  listen({ fetch: () => Promise.resolve(Response.json(body)), host: '127.0.0.1', onError: internalError, port: 0 })
