// The self-hosted server end to end, started the way the entrypoint starts it
// with only the Stalwart settings (plus the bearer for http), against a fake
// Stalwart on loopback. Every outbound request the process makes is recorded,
// to show it talks to STALWART_URL and nothing else: no Better Auth, no Auth
// service, no langmail.me.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import { SELF_HOSTED_INSTRUCTIONS } from '../mcp/instructions.ts'
import { startSelfHosted } from './main.ts'

const USERNAME = 'alice'
const PASSWORD = 'app pass:word'
const BASIC = `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`
const MCP_TOKEN = 'operator-secret'
const TYPE_FILTER_WORDING_RE = /classif|email type|by type|keywords/iu
const COLLECTED_BOOK_WORDING_RE = /mail headers|collected/iu

// --- fake Stalwart ---------------------------------------------------------

interface JmapCall {
  args: Record<string, unknown>
  name: string
}

const jmapCalls: JmapCall[] = []
let stalwart: ReturnType<typeof Bun.serve>
let stalwartUrl: string

const sessionBody = (base: string) => ({
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

// Every method answers "nothing here", which is enough for a search to run.
const emptyResponse = (args: Record<string, unknown>) => ({
  accountId: args.accountId,
  ids: [],
  list: [],
  notFound: [],
  position: 0,
  total: 0,
})

// --- outbound recording ----------------------------------------------------

const originalFetch = globalThis.fetch
const outbound: string[] = []

beforeAll(() => {
  stalwart = Bun.serve({
    fetch: async (req) => {
      if (req.headers.get('authorization') !== BASIC) {
        return new Response('unauthorized', { status: 401 })
      }
      const { pathname } = new URL(req.url)
      if (pathname === '/.well-known/jmap') {
        return Response.json(sessionBody(stalwartUrl))
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
    hostname: '127.0.0.1',
    port: 0,
  })
  stalwartUrl = `http://127.0.0.1:${stalwart.port}`
  // The process's own requests go through this; the test talks to the MCP
  // server with originalFetch, so only the server's traffic is recorded.
  globalThis.fetch = Object.assign(
    (input: Request | string | URL, init?: RequestInit) => {
      outbound.push(input instanceof Request ? input.url : String(input))
      return originalFetch(input, init)
    },
    { preconnect: originalFetch.preconnect }
  )
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  await stalwart.stop(true)
})

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop()
  }
})

const env = (extra: Record<string, string> = {}) => ({
  STALWART_PASSWORD: PASSWORD,
  STALWART_URL: stalwartUrl,
  STALWART_USERNAME: USERNAME,
  ...extra,
})

const startHttp = async () => {
  const result = await startSelfHosted({
    argv: ['--transport', 'http', '--port', '0'],
    env: env({ MCP_AUTH_TOKEN: MCP_TOKEN }),
  })
  if (!result.ok) {
    throw new Error(result.message)
  }
  stops.push(result.started.stop)
  return result.started
}

const rpc = async (url: string, method: string, params: Record<string, unknown>) => {
  const res = await originalFetch(`${url}/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${MCP_TOKEN}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  const data = (await res.text()).split('\n').find((line) => line.startsWith('data: '))
  if (!data) {
    throw new Error(`No JSON-RPC response to ${method} (HTTP ${res.status})`)
  }
  return (JSON.parse(data.slice('data: '.length)) as { result: Record<string, unknown> }).result
}

interface ListedTool {
  description: string
  inputSchema: { properties: Record<string, { description?: string }> }
  name: string
}

describe('self-hosted over http', () => {
  test('serves the mailbox with only the Stalwart settings, and requests nothing but STALWART_URL', async () => {
    outbound.length = 0
    jmapCalls.length = 0
    const { listenUrl } = await startHttp()

    const init = await rpc(listenUrl, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'self-hosted-test', version: '0' },
      protocolVersion: '2025-06-18',
    })
    expect(init.instructions).toBe(SELF_HOSTED_INSTRUCTIONS)

    const { tools } = (await rpc(listenUrl, 'tools/list', {})) as { tools: ListedTool[] }
    const names = new Set(tools.map((tool) => tool.name))
    expect(names.has('search_emails')).toBe(true)
    expect(names.has('list_calendars')).toBe(true)
    expect(names.has('search_contacts')).toBe(true)
    expect(names.has('share_calendar')).toBe(false)
    expect(names.has('stop_sharing_calendar')).toBe(false)

    const search = tools.find((tool) => tool.name === 'search_emails')
    expect(search?.inputSchema.properties.todo).toBeDefined()
    expect(search?.inputSchema.properties.keywords).toBeUndefined()
    const searchText = JSON.stringify(search)
    expect(searchText).not.toMatch(TYPE_FILTER_WORDING_RE)

    const contactsText = JSON.stringify(tools.filter((tool) => tool.name.includes('contact')))
    expect(contactsText).not.toMatch(COLLECTED_BOOK_WORDING_RE)

    const result = (await rpc(listenUrl, 'tools/call', { arguments: { todo: true }, name: 'search_emails' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(result.isError).toBeFalsy()
    const query = jmapCalls.find((call) => call.name === 'Email/query')
    expect(JSON.stringify(query?.args.filter)).toContain('$label:todo')

    // A contacts tool too, over the JMAP contacts account.
    const contacts = (await rpc(listenUrl, 'tools/call', {
      arguments: { query: 'robin' },
      name: 'search_contacts',
    })) as {
      isError?: boolean
    }
    expect(contacts.isError).toBeFalsy()
    expect(jmapCalls.some((call) => call.name.startsWith('ContactCard/'))).toBe(true)

    expect(outbound.length).toBeGreaterThan(0)
    expect(outbound.filter((url) => new URL(url).origin !== stalwartUrl)).toEqual([])
  })

  test('/mcp needs the operator bearer, and there is no OAuth discovery or feed route', async () => {
    const { listenUrl } = await startHttp()
    const post = (authorization?: string) =>
      originalFetch(`${listenUrl}/mcp`, {
        body: '{}',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
        method: 'POST',
      })

    const none = await post()
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
    expect((await post('Bearer wrong')).status).toBe(401)
    expect((await post(BASIC)).status).toBe(401)

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/calendar-feeds/abc.ics',
    ]) {
      expect((await originalFetch(`${listenUrl}${path}`)).status).toBe(404)
    }
    expect((await originalFetch(`${listenUrl}/healthz`)).status).toBe(200)
  })
})

describe('self-hosted startup checks', () => {
  test('wrong credentials stop the start, naming the URL and username Stalwart rejected', async () => {
    const result = await startSelfHosted({ argv: [], env: env({ STALWART_PASSWORD: 'wrong' }) })
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    expect(message).toContain(stalwartUrl)
    expect(message).toContain('"alice"')
  })

  test('a server that advertises its API on another host stops the start', async () => {
    const elsewhere = Bun.serve({
      fetch: () => Response.json(sessionBody('https://mail.example.com')),
      hostname: '127.0.0.1',
      port: 0,
    })
    try {
      const result = await startSelfHosted({
        argv: [],
        env: env({ STALWART_URL: `http://127.0.0.1:${elsewhere.port}` }),
      })
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.message).toContain('https://mail.example.com/jmap/')
    } finally {
      await elsewhere.stop(true)
    }
  })
})

describe('self-hosted over stdio', () => {
  test('answers initialize and tools/list on the given streams', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let closed = false
    const result = await startSelfHosted({
      argv: [],
      env: env(),
      onStdioClosed: () => {
        closed = true
      },
      stdin,
      stdout,
    })
    if (!result.ok) {
      throw new Error(result.message)
    }
    stops.push(result.started.stop)
    expect(result.started.transport).toBe('stdio')

    const lines: Record<string, unknown>[] = []
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    const send = (message: Record<string, unknown>) => stdin.write(`${JSON.stringify(message)}\n`)
    const answer = async (id: number) => {
      for (let i = 0; i < 100; i++) {
        const found = lines.find((line) => line.id === id)
        if (found) {
          return found as { result: Record<string, unknown> }
        }
        await Bun.sleep(10)
      }
      throw new Error(`no answer to ${id}`)
    }

    send({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 't', version: '0' }, protocolVersion: '2025-06-18' },
    })
    expect((await answer(1)).result.instructions).toBe(SELF_HOSTED_INSTRUCTIONS)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} })
    const { tools } = (await answer(2)).result as { tools: { name: string }[] }
    expect(tools.some((tool) => tool.name === 'get_email')).toBe(true)
    expect(tools.some((tool) => tool.name === 'share_calendar')).toBe(false)

    // The ticket routes still listen, for the links download_attachment mints.
    expect((await originalFetch(`${result.started.listenUrl}/healthz`)).status).toBe(200)

    // The client closing stdin stops the listener, so the process can exit.
    stdin.end()
    for (let i = 0; i < 100 && !closed; i++) {
      await Bun.sleep(10)
    }
    expect(closed).toBe(true)
    expect(originalFetch(`${result.started.listenUrl}/healthz`)).rejects.toThrow()
  })
})
