import { describe, expect, spyOn, test } from 'bun:test'

import { makeJmapLive } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { createTicketStore } from '../attachments/tickets.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { createImageProxyStore } from '../email-render/image-proxy.ts'
import { createMcpHandler } from './handler.ts'

const handle = createMcpHandler({
  imageTokens: createImageProxyStore(),
  live: makeJmapLive('https://mail.example.com'),
  publicUrl: 'https://mcp.example.com',
  recordAgentActivity: async () => undefined,
  stalwartUrl: 'https://mail.example.com',
  tickets: createTicketStore(),
  uploadTickets: createUploadTicketStore(),
})

interface RpcMessage {
  error?: { code: number; message: string }
  result?: { content?: { text: string; type: string }[]; isError?: boolean }
}

// One tools/call through the real per-request server and transport, the path
// an authenticated /mcp request takes. Every call here is answered before a
// handler would reach Stalwart, so the placeholder URLs are never dialled.
const callTool = async (name: string, args: Record<string, unknown>): Promise<RpcMessage> => {
  const res = await handle(
    new Request('https://mcp.example.com/mcp', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: args, name } }),
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      method: 'POST',
    }),
    { exp: 0, principal: 'user@example.com', token: 'token', userId: 'user_123' }
  )
  const text = await res.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  if (!data) {
    throw new Error(`No JSON-RPC response in: ${text}`)
  }
  return JSON.parse(data.slice('data: '.length)) as RpcMessage
}

const textOf = (message: RpcMessage): string => message.result?.content?.map((c) => c.text).join('\n') ?? ''

describe('tools/call through the MCP handler', () => {
  test('answers input that fails the schema in-band, naming the field', async () => {
    const message = await callTool('delete_mail_rule', {})

    expect(message.error).toBeUndefined()
    expect(message.result?.isError).toBe(true)
    expect(textOf(message)).toContain('ruleId')
  })

  // search_emails with no filter passes the schema and is refused by the tool
  // itself, so this also checks that instrumentToolLogging wraps tools
  // registered on the real, overloaded McpServer.registerTool.
  test("returns the tool's own refusal and logs it as a tool_error", async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const message = await callTool('search_emails', {})

      expect(message.result?.isError).toBe(true)
      expect(textOf(message)).not.toContain('Input validation error')
      const fields = warn.mock.calls.map((call) => call[0] as Record<string, unknown>)
      expect(fields).toContainEqual(expect.objectContaining({ outcome: 'tool_error', tool: 'search_emails' }))
    } finally {
      warn.mockRestore()
    }
  })

  // The schema refuses what the wall-clock parser cannot read, so the call is
  // answered before the handler runs and nothing reaches the calendar.
  test.each([
    ['create_calendar_event', { end: '2026-10-03T11:00:00', start: '2026-10-03T10:00', title: 'Standup' }],
    ['update_calendar_event', { start: '2026-10-03T10:00', uid: 'event-1' }],
    ['update_calendar_event', { end: '2026-10-03T11:00', start: '2026-10-03T10:00', uid: 'event-1' }],
    ['update_calendar_event', { end: '2026-10-03T11:00:00.1234', uid: 'event-1' }],
  ])('%p refuses a date-time the parser cannot read, in-band', async (name, args) => {
    const message = await callTool(name, args)

    expect(message.error).toBeUndefined()
    expect(message.result?.isError).toBe(true)
    expect(textOf(message)).toContain('a date-time with seconds')
  })

  test('rejects an unknown tool with a JSON-RPC invalid-params error', async () => {
    const message = await callTool('no_such_tool', {})

    expect(message.result).toBeUndefined()
    expect(message.error?.code).toBe(-32_602)
  })
})
