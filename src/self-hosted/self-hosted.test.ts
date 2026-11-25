// The self-hosted server end to end, started the way the entrypoint starts it
// with only the Stalwart settings (plus the bearer for http), against a fake
// Stalwart on loopback. Every outbound request the process makes is recorded,
// to show it talks to STALWART_URL and nothing else: no Better Auth, no Auth
// service, no langmail.me.

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { after, afterEach, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { buildInstructions } from '../mcp/instructions.ts'
import {
  type FakeStalwart,
  fakeSessionBody,
  startFakeStalwart,
  startJsonServer,
} from '../test-support/fake-stalwart.ts'
import { startSelfHosted } from './main.ts'

// node:test, not bun:test: CI runs this file under Node as well as Bun
// (scripts/test-node.ts), since the langmail-mcp package runs under both.

const USERNAME = 'alice'
const PASSWORD = 'app pass:word'
const BASIC = `Basic ${btoa(`${USERNAME}:${PASSWORD}`)}`
const MCP_TOKEN = 'operator-secret'
const TYPE_FILTER_WORDING_RE = /classif|email type|by type|keywords/iu
const COLLECTED_BOOK_WORDING_RE = /mail headers|collected/iu

let stalwart: FakeStalwart
let stalwartUrl: string

// --- outbound recording ----------------------------------------------------

const SELF_HOSTED_INSTRUCTIONS = buildInstructions({ level: 'everything', mode: 'self-hosted', sharing: false })

const originalFetch = globalThis.fetch
const outbound: string[] = []

before(async () => {
  stalwart = await startFakeStalwart({ password: PASSWORD, username: USERNAME })
  stalwartUrl = stalwart.url
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

after(async () => {
  globalThis.fetch = originalFetch
  await stalwart.stop()
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
    stalwart.jmapCalls.length = 0
    const { listenUrl } = await startHttp()

    const init = await rpc(listenUrl, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'self-hosted-test', version: '0' },
      protocolVersion: '2025-06-18',
    })
    assert.equal(init.instructions, SELF_HOSTED_INSTRUCTIONS)

    const { tools } = (await rpc(listenUrl, 'tools/list', {})) as { tools: ListedTool[] }
    const names = new Set(tools.map((tool) => tool.name))
    assert.ok(names.has('search_emails'))
    assert.ok(names.has('list_calendars'))
    assert.ok(names.has('search_contacts'))
    assert.ok(!names.has('share_calendar'))
    assert.ok(!names.has('stop_sharing_calendar'))

    const search = tools.find((tool) => tool.name === 'search_emails')
    assert.notEqual(search?.inputSchema.properties.todo, undefined)
    assert.equal(search?.inputSchema.properties.keywords, undefined)
    const searchText = JSON.stringify(search)
    assert.doesNotMatch(searchText, TYPE_FILTER_WORDING_RE)

    const contactsText = JSON.stringify(tools.filter((tool) => tool.name.includes('contact')))
    assert.doesNotMatch(contactsText, COLLECTED_BOOK_WORDING_RE)
    // Self-hosted merge_contacts keeps no interaction history, so delete_contact
    // must not promise it.
    const deleteContact = tools.find((tool) => tool.name === 'delete_contact')
    assert.ok(
      deleteContact?.description.includes(
        'merge_contacts, which keeps its email addresses, phone numbers, postal addresses and notes.'
      )
    )
    assert.ok(!deleteContact?.description.includes('history'))

    const result = (await rpc(listenUrl, 'tools/call', { arguments: { todo: true }, name: 'search_emails' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    assert.ok(!result.isError)
    const query = stalwart.jmapCalls.find((call) => call.name === 'Email/query')
    assert.ok(JSON.stringify(query?.args.filter).includes('$label:todo'))

    // A contacts tool too, over the JMAP contacts account.
    const contacts = (await rpc(listenUrl, 'tools/call', {
      arguments: { query: 'robin' },
      name: 'search_contacts',
    })) as {
      isError?: boolean
    }
    assert.ok(!contacts.isError)
    assert.ok(stalwart.jmapCalls.some((call) => call.name.startsWith('ContactCard/')))

    assert.ok(outbound.length > 0)
    assert.deepEqual(
      outbound.filter((url) => new URL(url).origin !== stalwartUrl),
      []
    )
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
    assert.equal(none.status, 401)
    assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="mcp"')
    assert.equal((await post('Bearer wrong')).status, 401)
    assert.equal((await post(BASIC)).status, 401)

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/calendar-feeds/abc.ics',
    ]) {
      assert.equal((await originalFetch(`${listenUrl}${path}`)).status, 404)
    }
    assert.equal((await originalFetch(`${listenUrl}/healthz`)).status, 200)
  })
})

describe('self-hosted startup checks', () => {
  test('wrong credentials stop the start, naming the URL and username Stalwart rejected', async () => {
    const result = await startSelfHosted({ argv: [], env: env({ STALWART_PASSWORD: 'wrong' }) })
    assert.equal(result.ok, false)
    const message = result.ok ? '' : result.message
    assert.ok(message.includes(stalwartUrl), message)
    assert.ok(message.includes('"alice"'), message)
  })

  test('a server that advertises its API on another host stops the start', async () => {
    const elsewhere = await startJsonServer(fakeSessionBody('https://mail.example.com'))
    try {
      const result = await startSelfHosted({
        argv: [],
        env: env({ STALWART_URL: `http://127.0.0.1:${elsewhere.port}` }),
      })
      assert.equal(result.ok, false)
      assert.ok((result.ok ? '' : result.message).includes('https://mail.example.com/jmap/'))
    } finally {
      await elsewhere.stop()
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
    assert.equal(result.started.transport, 'stdio')

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
        await sleep(10)
      }
      throw new Error(`no answer to ${id}`)
    }

    send({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 't', version: '0' }, protocolVersion: '2025-06-18' },
    })
    assert.equal((await answer(1)).result.instructions, SELF_HOSTED_INSTRUCTIONS)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} })
    const { tools } = (await answer(2)).result as { tools: { name: string }[] }
    assert.ok(tools.some((tool) => tool.name === 'get_email'))
    assert.ok(!tools.some((tool) => tool.name === 'share_calendar'))

    // The ticket routes still listen, for the links download_attachment mints.
    assert.equal((await originalFetch(`${result.started.listenUrl}/healthz`)).status, 200)

    // The client closing stdin stops the listener, so the process can exit.
    stdin.end()
    for (let i = 0; i < 100 && !closed; i++) {
      await sleep(10)
    }
    assert.ok(closed)
    await assert.rejects(originalFetch(`${result.started.listenUrl}/healthz`))
  })
})
