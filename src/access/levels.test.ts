import { describe, expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { createTicketStore } from '../attachments/tickets.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { createImageProxyStore } from '../email-render/image-proxy.ts'
import { makeJmapLive } from '../jmap/index.ts'
import { createMcpServerFactory } from '../mcp/handler.ts'
import { fakeShareStore } from '../tools/calendar-share-test-fixtures.ts'
import { ACCESS_LEVELS, type AccessLevel, allows, TOOL_ACCESS, type ToolName } from './levels.ts'
import { restrictToAccess } from './restrict.ts'

const build = createMcpServerFactory({
  calendarShares: fakeShareStore(),
  imageTokens: createImageProxyStore(),
  live: makeJmapLive('https://mail.example.com'),
  publicUrl: 'https://mcp.example.com',
  recordAgentActivity: async () => undefined,
  stalwartUrl: 'https://mail.example.com',
  tickets: createTicketStore(),
  uploadTickets: createUploadTicketStore(),
})

// The tools a server built for `access` registered, read off the McpServer
// without a transport.
const registered = (access: AccessLevel): string[] => {
  const server = build({ access, principal: 'user@example.com', token: 'token', userId: 'user_123' })
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort()
}

const toolNames = Object.keys(TOOL_ACCESS) as ToolName[]

describe('access levels', () => {
  test('every tool the hosted server offers has a level, and every level names a tool it offers', () => {
    expect(registered('everything')).toEqual([...toolNames].sort())
  })

  test('each level offers exactly its tools', () => {
    for (const access of ACCESS_LEVELS) {
      expect(registered(access)).toEqual(toolNames.filter((tool) => allows(access, tool)).sort())
    }
  })

  test('each level offers everything the level below it offers', () => {
    for (const tool of toolNames) {
      const offered = ACCESS_LEVELS.map((access) => allows(access, tool))
      expect(offered.indexOf(true)).toBe(ACCESS_LEVELS.indexOf(TOOL_ACCESS[tool]))
      expect(offered.slice(offered.indexOf(true)).every(Boolean)).toBe(true)
    }
  })

  test('nothing that sends mail or reaches another person is offered below Everything', () => {
    for (const tool of [
      'send_draft',
      'reply_to_message',
      'forward_message',
      'unsubscribe_from_list',
      'share_calendar',
      'respond_to_event',
    ] as const) {
      expect(TOOL_ACCESS[tool]).toBe('everything')
    }
  })

  test('registering a tool with no level fails', () => {
    const server = new McpServer({ name: 'test', version: '0' })
    restrictToAccess(server, 'everything', 'hosted')

    expect(() =>
      server.registerTool('frobnicate_emails', { inputSchema: z.object({}) }, () => ({ content: [] }))
    ).toThrow('has no access level')
  })
})
