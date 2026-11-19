// The hosted server's tool surface, pinned: every tool's name, title,
// description, annotations and input schema, plus the server instructions, with
// and without calendar sharing. A change to what agents see on the hosted
// server shows up as a snapshot diff, so it is a decision rather than a side
// effect of work on another mode. Regenerate with `bun test --update-snapshots`
// only when the hosted change is intended.

import { describe, expect, test } from 'bun:test'

import { createTicketStore } from '../attachments/tickets.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { createImageProxyStore } from '../email-render/image-proxy.ts'
import { makeJmapLive } from '../jmap/index.ts'
import { fakeShareStore } from '../tools/calendar-share-test-fixtures.ts'
import { createMcpHandler } from './handler.ts'

const handler = (sharing: boolean) =>
  createMcpHandler({
    ...(sharing ? { calendarShares: fakeShareStore() } : {}),
    imageTokens: createImageProxyStore(),
    live: makeJmapLive('https://mail.example.com'),
    publicUrl: 'https://mcp.example.com',
    recordAgentActivity: async () => undefined,
    stalwartUrl: 'https://mail.example.com',
    tickets: createTicketStore(),
    uploadTickets: createUploadTicketStore(),
  })

const rpc = async (sharing: boolean, method: string, params: Record<string, unknown>): Promise<unknown> => {
  const res = await handler(sharing)(
    new Request('https://mcp.example.com/mcp', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      method: 'POST',
    }),
    { exp: 0, principal: 'user@example.com', token: 'token', userId: 'user_123' }
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
