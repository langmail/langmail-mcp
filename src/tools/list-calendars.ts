// list_calendars tool — returns the authenticated principal's calendars
// (display name + CalDAV URL) via RFC 6764 discovery.
//
// Like search-emails.ts, the logic sits behind a `Deps` interface so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { CalDavConfig } from '../caldav/client.ts'
import { fetchCalendarList } from '../caldav/client.ts'
import type { CalendarSummary } from '../caldav/types.ts'
import type { ToolResult } from './result.ts'
import { textResult } from './result.ts'

// No inputs: the principal is implied by the bearer.
const listCalendarsInput = z.object({})

export interface ListCalendarsDeps {
  listCalendars: (token: string) => Promise<CalendarSummary[]>
}

export interface ListCalendarsContext {
  token: string
}

const formatCalendar = (idx: number, cal: CalendarSummary): string =>
  `${idx}. ${cal.displayName || '(unnamed)'}\n   url: ${cal.url}`

export const listCalendars = async (deps: ListCalendarsDeps, ctx: ListCalendarsContext): Promise<ToolResult> => {
  const calendars = await deps.listCalendars(ctx.token)
  if (calendars.length === 0) {
    return textResult('No calendars found.')
  }
  const lines = calendars.map((c, i) => formatCalendar(i + 1, c))
  return textResult(`${calendars.length} calendar(s):\n\n${lines.join('\n\n')}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): ListCalendarsDeps => ({
  listCalendars: (token) => fetchCalendarList(cfg, token),
})

// --- MCP registration ----------------------------------------------------

export const registerListCalendars = (
  server: McpServer,
  deps: ListCalendarsDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'list_calendars',
    {
      description:
        "Lists the authenticated user's calendars. Returns each calendar's " +
        'display name and CalDAV URL (the URL is what create_calendar_event takes).',
      inputSchema: listCalendarsInput.shape,
      title: 'List calendars',
    },
    () => listCalendars(deps, { token: getToken() })
  )
}
