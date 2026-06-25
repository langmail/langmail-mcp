// list_calendar_events tool — lists the events in a calendar (optionally
// within a time range) so the agent can find an event's UID to feed to
// update_calendar_event / delete_calendar_event.
//
// Logic sits behind a `Deps` interface (discover + fetchEvents) so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { CalDavConfig, FetchEventsParams } from '../caldav/client.ts'
import { discoverAccount, fetchEvents, resolveCalendarUrl } from '../caldav/client.ts'
import type { ParsedEvent } from '../caldav/ical-parse.ts'
import { parseEvents } from '../caldav/ical-parse.ts'
import type { CalendarObject, DiscoveredAccount } from '../caldav/types.ts'
import type { ToolResult } from './result.ts'
import { errorResult, textResult } from './result.ts'

export const listCalendarEventsInput = z.object({
  // Optional CalDAV URL from list_calendars; defaults to the principal's
  // discovered default calendar.
  calendarUrl: z.url().optional(),
  // Optional inclusive window. Both bounds are ISO 8601 with offset and
  // must be supplied together (enforced in the handler).
  end: z.iso.datetime({ offset: true }).optional(),
  start: z.iso.datetime({ offset: true }).optional(),
})

export type ListCalendarEventsArgs = z.infer<typeof listCalendarEventsInput>

export interface ListCalendarEventsDeps {
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvents: (params: FetchEventsParams) => Promise<CalendarObject[]>
}

export interface ListCalendarEventsContext {
  args: ListCalendarEventsArgs
  token: string
}

const formatEvent = (idx: number, ev: ParsedEvent): string => {
  const when = ev.end ? `${ev.start} → ${ev.end}` : ev.start
  const lines = [`${idx}. ${ev.title || '(no title)'}`, `   when: ${when}`]
  if (ev.location) {
    lines.push(`   location: ${ev.location}`)
  }
  if (ev.recurrence) {
    lines.push(`   repeats: ${ev.recurrence}`)
  }
  lines.push(`   uid: ${ev.uid}`)
  return lines.join('\n')
}

export const listCalendarEvents = async (
  deps: ListCalendarEventsDeps,
  ctx: ListCalendarEventsContext
): Promise<ToolResult> => {
  const { args, token } = ctx

  if ((args.start === undefined) !== (args.end === undefined)) {
    return errorResult('Provide both start and end, or neither.')
  }

  const account = await deps.discover(token)

  const resolved = resolveCalendarUrl(account, args.calendarUrl)
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === 'none'
        ? 'No calendar available to list events from.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }

  const objects = await deps.fetchEvents({
    calendarUrl: resolved.url,
    token,
    ...(args.start && args.end ? { timeRange: { end: args.end, start: args.start } } : {}),
  })

  // Lexicographic sort on the rendered start. Exact for our UTC events;
  // approximate if the server returns floating TZID times (no `Z`), which
  // can order against a UTC instant slightly wrong — acceptable for a list.
  const events = objects.flatMap((o) => parseEvents(o.data)).sort((a, b) => a.start.localeCompare(b.start))
  if (events.length === 0) {
    return textResult('No events found.')
  }

  const lines = events.map((ev, i) => formatEvent(i + 1, ev))
  return textResult(`${events.length} event(s):\n\n${lines.join('\n\n')}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): ListCalendarEventsDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  fetchEvents: (params) => fetchEvents(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerListCalendarEvents = (
  server: McpServer,
  deps: ListCalendarEventsDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'list_calendar_events',
    {
      description:
        "Lists events in the user's calendar, returning each event's title, time, " +
        'location, and uid. Pass the uid to update_calendar_event or ' +
        'delete_calendar_event. Optionally bound the results with a start/end window ' +
        '(ISO 8601 with offset); omit both to list everything. Defaults to the ' +
        'user’s default calendar.',
      inputSchema: listCalendarEventsInput.shape,
      title: 'List calendar events',
    },
    (args) => {
      const parsed = listCalendarEventsInput.parse(args)
      return listCalendarEvents(deps, { args: parsed, token: getToken() })
    }
  )
}
