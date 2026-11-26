// The hosted server's tool surface, pinned: every tool's name, title,
// description, annotations and input schema, plus the server instructions, with
// and without calendar sharing. A change to what agents see on the hosted
// server shows up as a snapshot diff, so it is a decision rather than a side
// effect of work on another mode. Regenerate with `bun test --update-snapshots`
// only when the hosted change is intended.

import { describe, expect, test } from 'bun:test'

import { ACCESS_LEVELS, type AccessLevel } from '../access/levels.ts'
import { createTicketStore } from '../attachments/tickets.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { createImageProxyStore } from '../email-render/image-proxy.ts'
import { makeJmapLive } from '../jmap/index.ts'
import { fakeShareStore } from '../tools/calendar-share-test-fixtures.ts'
import { createMcpHandler } from './handler.ts'

const handler = (sharing: boolean, selfHosted = false) =>
  createMcpHandler({
    ...(sharing ? { calendarShares: fakeShareStore() } : {}),
    ...(selfHosted ? { mode: 'self-hosted' as const } : {}),
    imageTokens: createImageProxyStore(),
    live: makeJmapLive('https://mail.example.com'),
    publicUrl: 'https://mcp.example.com',
    recordAgentActivity: async () => undefined,
    stalwartUrl: 'https://mail.example.com',
    tickets: createTicketStore(),
    uploadTickets: createUploadTicketStore(),
  })

const rpc = async (
  sharing: boolean,
  method: string,
  params: Record<string, unknown>,
  access: AccessLevel = 'everything',
  selfHosted = false
): Promise<unknown> => {
  const res = await handler(sharing, selfHosted)(
    new Request('https://mcp.example.com/mcp', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      method: 'POST',
    }),
    { access, exp: 0, principal: 'user@example.com', token: 'token', userId: 'user_123' }
  )
  const data = (await res.text()).split('\n').find((line) => line.startsWith('data: '))
  if (!data) {
    throw new Error(`No JSON-RPC response to ${method}`)
  }
  return (JSON.parse(data.slice('data: '.length)) as { result: unknown }).result
}

describe('hosted tool surface', () => {
  for (const sharing of [true, false]) {
    test(`tools/list and instructions, sharing ${sharing ? 'on' : 'off'}`, async () => {
      const init = (await rpc(sharing, 'initialize', {
        capabilities: {},
        clientInfo: { name: 'tool-surface-test', version: '0' },
        protocolVersion: '2025-06-18',
      })) as { instructions: string }
      const list = (await rpc(sharing, 'tools/list', {})) as { tools: { name: string }[] }
      // Without sharing the surface is the same minus two tools, so only the
      // names are pinned there; the full definitions once is enough.
      const tools = sharing ? list.tools : list.tools.map((tool) => tool.name)
      expect({ instructions: init.instructions, tools }).toMatchSnapshot()
    })
  }
})

// What each access level offers, hosted (with and without sharing) and
// self-hosted: the tool names and the instructions. Everything is pinned in
// full above; this pins the lower levels and the self-hosted surface.
describe('tool surface per access level', () => {
  const surfaces = [
    { label: 'hosted, sharing on', selfHosted: false, sharing: true },
    { label: 'hosted, sharing off', selfHosted: false, sharing: false },
    { label: 'self-hosted', selfHosted: true, sharing: false },
  ]
  for (const access of ACCESS_LEVELS) {
    for (const { label, selfHosted, sharing } of surfaces) {
      test(`${access}, ${label}`, async () => {
        const init = (await rpc(
          sharing,
          'initialize',
          {
            capabilities: {},
            clientInfo: { name: 'tool-surface-test', version: '0' },
            protocolVersion: '2025-06-18',
          },
          access,
          selfHosted
        )) as { instructions: string }
        const list = (await rpc(sharing, 'tools/list', {}, access, selfHosted)) as { tools: { name: string }[] }
        expect({ instructions: init.instructions, tools: list.tools.map((tool) => tool.name) }).toMatchSnapshot()
      })
    }
  }
})

// The event and rule writers at Change, never send register a narrowed form
// (src/access/levels.ts): pinned in full, so their schemas and annotations are
// a decision too. At Everything they are the full forms pinned above.
test('narrowed tools at no-send, in full', async () => {
  const narrowed = new Set([
    'create_calendar_event',
    'create_mail_rule',
    'delete_calendar_event',
    'update_calendar_event',
    'update_mail_rule',
  ])
  const list = (await rpc(true, 'tools/list', {}, 'no-send')) as { tools: { name: string }[] }
  expect(list.tools.filter((tool) => narrowed.has(tool.name))).toMatchSnapshot()
})
