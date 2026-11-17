// list_calendars tool — returns the authenticated principal's calendars
// (display name, CalDAV URL, and color) via RFC 6764 discovery, and who each
// one is shared with, at which level (calendar-share-common.ts).
//
// Like search-emails.ts, the logic sits behind a `Deps` interface so it
// unit-tests without live Stalwart; the sharing deps wire tsdav and Postgres in.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { type CalendarSummary } from '../caldav/types.ts'
import { type CalendarShare } from '../calendar-feeds/shares.ts'
import { READ_ONLY } from './annotations.ts'
import { type CalendarSharingContext, type CalendarSharingDeps, levelWords, sharesOn } from './calendar-share-common.ts'
import { type ToolResult, textResult } from './result.ts'

// No inputs: the principal is implied by the bearer.
const listCalendarsInput = z.object({})

// Undefined when sharing is off or the shares failed to load.
const sharingLine = (shares: CalendarShare[] | undefined, cal: CalendarSummary): string => {
  if (!shares) {
    return '\n   sharing: unknown (calendar sharing is not available right now)'
  }
  const on = sharesOn(shares, cal)
  return on.length === 0
    ? '\n   not shared'
    : `\n   shared with: ${on.map((s) => `${s.label} (${levelWords(s.level)})`).join(', ')}`
}

const formatCalendar = (idx: number, cal: CalendarSummary, shares: CalendarShare[] | undefined): string =>
  `${idx}. ${cal.displayName || '(unnamed)'}\n   url: ${cal.url}${cal.color ? `\n   color: ${cal.color}` : ''}` +
  sharingLine(shares, cal)

export const listCalendars = async (deps: CalendarSharingDeps, ctx: CalendarSharingContext): Promise<ToolResult> => {
  const [calendars, shares] = await Promise.all([
    deps.listCalendars(ctx.token), // Shares failing to load leave the calendars listed, as with sharing off.
    deps.shares?.list(ctx.userId).catch(() => undefined),
  ])
  if (calendars.length === 0) {
    return textResult('No calendars found.')
  }
  const lines = calendars.map((c, i) => formatCalendar(i + 1, c, shares))
  return textResult(`${calendars.length} calendar(s):\n\n${lines.join('\n\n')}`)
}

// --- MCP registration ----------------------------------------------------

export const registerListCalendars = (
  server: McpServer,
  deps: CalendarSharingDeps,
  // Bearer and user id threaded per request — see mcp/handler.ts.
  getToken: () => string,
  getUserId: () => string
): void => {
  server.registerTool(
    'list_calendars',
    {
      annotations: READ_ONLY,
      description:
        "Lists the authenticated user's calendars — the calendars themselves, not the events on them. " +
        'Use this to see which calendars exist before adding an event to a specific one, or to find the ' +
        'calendar to rename or recolor, or to answer who can see the user’s calendars. Returns each ' +
        'calendar’s name, CalDAV URL, color when it has one, and every person it is shared with at which ' +
        'level (the share links themselves cannot be shown again); the URL is what create_calendar_event, ' +
        'update_calendar and move_calendar_events take. ' +
        'For the events on a calendar use list_calendar_events; to rename or recolor one use ' +
        'update_calendar; to move events onto one use move_calendar_events; to share one or stop a share ' +
        'use share_calendar or stop_sharing_calendar.',
      inputSchema: listCalendarsInput,
      title: 'List calendars',
    },
    () => listCalendars(deps, { token: getToken(), userId: getUserId() })
  )
}
