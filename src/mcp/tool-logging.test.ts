import { describe, expect, spyOn, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { logger } from '@langmail/logger'

import { instrumentToolLogging } from './tool-logging.ts'

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

// Spy on the shared logger rather than replacing the module: mock.module is
// process-wide for the whole test run, and a stale replacement would follow
// every other file that logs (see update-calendar-event.test.ts).
const withLogSpies = async (
  fn: (spies: { error: ReturnType<typeof spyOn>; info: ReturnType<typeof spyOn> }) => Promise<void>
): Promise<void> => {
  const info = spyOn(logger, 'info').mockImplementation(() => undefined)
  const error = spyOn(logger, 'error').mockImplementation(() => undefined)
  try {
    await fn({ error, info })
  } finally {
    info.mockRestore()
    error.mockRestore()
  }
}

describe('instrumentToolLogging', () => {
  test('logs name, duration and outcome for a successful call', async () => {
    await withLogSpies(async ({ error, info }) => {
      const { registered, server } = makeServer()
      register(server, 'list_calendars', () => ({ content: [{ text: '2 calendars', type: 'text' }] }))

      const result = await registered.get('list_calendars')?.({}, {})

      expect(result).toEqual({ content: [{ text: '2 calendars', type: 'text' }] })
      expect(error).not.toHaveBeenCalled()
      expect(info).toHaveBeenCalledTimes(1)
      const fields = info.mock.calls[0]?.[0] as Record<string, unknown>
      expect(fields.tool).toBe('list_calendars')
      expect(fields.outcome).toBe('success')
      expect(typeof fields.durationMs).toBe('number')
    })
  })

  test('counts an isError result as a failure without quoting its text', async () => {
    await withLogSpies(async ({ error, info }) => {
      const { registered, server } = makeServer()
      register(server, 'create_calendar_event', () => ({
        content: [{ text: 'Conflicts with lunch with bob@langmail.me', type: 'text' }],
        isError: true,
      }))

      await registered.get('create_calendar_event')?.({}, {})

      expect(info).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
      const fields = error.mock.calls[0]?.[0] as Record<string, unknown>
      expect(fields.tool).toBe('create_calendar_event')
      expect(fields.outcome).toBe('tool_error')
      expect(JSON.stringify(fields)).not.toContain('bob@langmail.me')
    })
  })

  test('logs a thrown error by class and rethrows it', async () => {
    await withLogSpies(async ({ error }) => {
      const { registered, server } = makeServer()
      register(server, 'search_emails', () => {
        throw new TypeError('fetch failed for alice@langmail.me')
      })

      const thrown = await registered
        .get('search_emails')?.({}, {})
        .catch((err: unknown) => err)

      expect(thrown).toBeInstanceOf(TypeError)
      const fields = error.mock.calls[0]?.[0] as Record<string, unknown>
      expect(fields.tool).toBe('search_emails')
      expect(fields.outcome).toBe('exception')
      expect(fields.errorClass).toBe('TypeError')
      expect(fields.errorMessage).toBe('fetch failed for [email]')
    })
  })
})
