import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Capture the log lines instead of shipping them. Installed before importing
// the module under test (Bun evaluates mock.module eagerly). The double carries
// every level because mock.module replaces the module for the whole test run,
// including files that only log in passing.
const info = mock((_fields: Record<string, unknown>, _msg: string) => undefined)
const error = mock((_fields: Record<string, unknown>, _msg: string) => undefined)
const noop = (): undefined => undefined
const logger = { child: () => logger, debug: noop, error, fatal: noop, info, trace: noop, warn: noop }
mock.module('@langmail/logger', () => ({ logger }))

const { instrumentToolLogging } = await import('./tool-logging.ts')

type Registered = (args: unknown, extra: unknown) => Promise<unknown>

// A stand-in for the one method the wrapper patches, so the test drives a tool
// callback directly instead of through a transport.
const makeServer = (): { registered: Map<string, Registered>; server: McpServer } => {
  const registered = new Map<string, Registered>()
  const server = {
    registerTool: (name: string, _config: unknown, cb: Registered) => {
      registered.set(name, cb)
      return { name }
    },
  } as unknown as McpServer
  instrumentToolLogging(server)
  return { registered, server }
}

const register = (server: McpServer, name: string, cb: () => unknown): void => {
  // The real McpServer.registerTool is generic over the tool's input shape; the
  // fake above is not, so the call is made through the loose shape.
  ;(server.registerTool as unknown as (n: string, c: unknown, f: () => unknown) => unknown)(name, {}, cb)
}

describe('instrumentToolLogging', () => {
  beforeEach(() => {
    info.mockClear()
    error.mockClear()
  })

  test('logs name, duration and outcome for a successful call', async () => {
    const { registered, server } = makeServer()
    register(server, 'list_calendars', () => ({ content: [{ text: '2 calendars', type: 'text' }] }))

    const result = await registered.get('list_calendars')?.({}, {})

    expect(result).toEqual({ content: [{ text: '2 calendars', type: 'text' }] })
    expect(error).not.toHaveBeenCalled()
    const [fields] = info.mock.calls[0] ?? []
    expect(fields?.tool).toBe('list_calendars')
    expect(fields?.outcome).toBe('success')
    expect(typeof fields?.durationMs).toBe('number')
  })

  test('counts an isError result as a failure without quoting its text', async () => {
    const { registered, server } = makeServer()
    register(server, 'create_calendar_event', () => ({
      content: [{ text: 'Conflicts with lunch with bob@langmail.me', type: 'text' }],
      isError: true,
    }))

    await registered.get('create_calendar_event')?.({}, {})

    expect(info).not.toHaveBeenCalled()
    const [fields] = error.mock.calls[0] ?? []
    expect(fields?.tool).toBe('create_calendar_event')
    expect(fields?.outcome).toBe('tool_error')
    expect(JSON.stringify(fields)).not.toContain('bob@langmail.me')
  })

  test('logs a thrown error by class and rethrows it', async () => {
    const { registered, server } = makeServer()
    register(server, 'search_emails', () => {
      throw new TypeError('fetch failed for alice@langmail.me')
    })

    const thrown = await registered
      .get('search_emails')?.({}, {})
      .catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(TypeError)
    const [fields] = error.mock.calls[0] ?? []
    expect(fields?.tool).toBe('search_emails')
    expect(fields?.outcome).toBe('exception')
    expect(fields?.errorClass).toBe('TypeError')
    expect(fields?.errorMessage).toBe('fetch failed for [email]')
  })
})
