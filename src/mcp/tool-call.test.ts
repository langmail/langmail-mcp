import { describe, expect, spyOn, test } from 'bun:test'

import { type AccessLevel } from '../access/levels.ts'
import { createTicketStore } from '../attachments/tickets.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { createImageProxyStore } from '../email-render/image-proxy.ts'
import { makeJmapLive } from '../jmap/index.ts'
import { logger } from '../logger/index.ts'
import { createMcpHandler } from './handler.ts'

const config = {
  imageTokens: createImageProxyStore(),
  live: makeJmapLive('https://mail.example.com'),
  publicUrl: 'https://mcp.example.com',
  recordAgentActivity: async () => undefined,
  stalwartUrl: 'https://mail.example.com',
  tickets: createTicketStore(),
  uploadTickets: createUploadTicketStore(),
}
const handlers = { hosted: createMcpHandler(config), selfHosted: createMcpHandler({ ...config, mode: 'self-hosted' }) }

interface RpcMessage {
  error?: { code: number; message: string }
  result?: { content?: { text: string; type: string }[]; isError?: boolean }
}

// One tools/call through the real per-request server and transport, the path
// an authenticated /mcp request takes. Every call here is answered before a
// handler would reach Stalwart, so the placeholder URLs are never dialled.
const callTool = async (
  name: string,
  args: Record<string, unknown>,
  access: AccessLevel = 'everything',
  mode: keyof typeof handlers = 'hosted'
): Promise<RpcMessage> => {
  const res = await handlers[mode](
    new Request('https://mcp.example.com/mcp', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: args, name } }),
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      method: 'POST',
    }),
    { access, exp: 0, principal: 'user@example.com', token: 'token', userId: 'user_123' }
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

  // A client may call a tool from a list it cached at a higher level. The call
  // is answered in-band, names the level and where to change it, and runs
  // nothing (the placeholder Stalwart URL would fail any real call).
  test.each([
    ['archive_emails', 'read-only', 'Read only'],
    ['send_draft', 'read-only', 'Read only'],
    ['send_draft', 'no-send', 'Change, never send'],
    ['respond_to_event', 'no-send', 'Change, never send'],
  ] as const)('%p at %p is refused in-band, naming the level', async (name, access, levelName) => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const message = await callTool(name, { ids: ['M1'] }, access)

      expect(message.error).toBeUndefined()
      expect(message.result?.isError).toBe(true)
      const text = textOf(message)
      expect(text).toContain(`${name} is not available`)
      expect(text).toContain(`${levelName} access`)
      expect(text).toContain('Nothing was changed or sent.')
      expect(text).toContain('under Access in Langmail')
      const fields = warn.mock.calls.map((call) => call[0] as Record<string, unknown>)
      expect(fields).toContainEqual(expect.objectContaining({ outcome: 'not_in_access_level', tool: name }))
    } finally {
      warn.mockRestore()
    }
  })

  // At Change, never send the event and rule writers are offered in a narrowed
  // form. A client calling with the full form's arguments, from a list cached
  // at Everything, gets them refused rather than silently dropped.
  test.each([
    [
      'create_calendar_event',
      { attendees: ['guest@example.com'], end: '2026-06-12T11:00:00Z', start: '2026-06-12T10:00:00Z', title: 'Sync' },
      'attendees',
    ],
    ['update_calendar_event', { addedAttendees: ['guest@example.com'], uid: 'evt-1' }, 'addedAttendees'],
    [
      'create_mail_rule',
      { actions: [{ to: 'someone@example.com', type: 'forward' }], conditions: { from: 'billing@example.com' } },
      'actions',
    ],
  ] as const)('%p at no-send refuses the full form’s outward arguments', async (name, args, field) => {
    const message = await callTool(name, args, 'no-send')

    expect(message.result?.isError).toBe(true)
    expect(textOf(message)).toContain(field)
  })

  test('a self-hosted refusal points at the --access option and does not name Langmail', async () => {
    const text = textOf(await callTool('archive_emails', { ids: ['M1'] }, 'read-only', 'selfHosted'))

    expect(text).toContain('--access')
    expect(text).not.toContain('Langmail')
  })

  test('a tool inside the level still runs', async () => {
    // The tool's own refusal, not the access refusal.
    const text = textOf(await callTool('search_emails', {}, 'read-only'))

    expect(text).not.toContain('is not available')
  })

  test('an unknown tool is still a JSON-RPC error at a lower level', async () => {
    const message = await callTool('no_such_tool', {}, 'read-only')

    expect(message.error?.code).toBe(-32_602)
  })
})
