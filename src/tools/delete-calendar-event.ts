// delete_calendar_event tool — removes an existing VEVENT from a CalDAV
// calendar, addressed by the stable UID from create_calendar_event. Deleting
// an organizer's scheduling object makes Stalwart fan out DKIM-signed iMIP
// CANCEL messages to the attendees (RFC 6638 server-side scheduling), so we
// don't build a cancellation iCal ourselves.
//
// We fetch the object first to confirm it exists (and pick up its ETag for a
// conditional DELETE) before removing it.
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + deleteEvent)
// so it unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  type CalDavConfig,
  type DeleteEventParams,
  deleteEvent,
  discoverAccount,
  type FetchEventParams,
  fetchEvent,
  resolveCalendarUrl,
} from '../caldav/client.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { eventUidSchema } from './create-calendar-event.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

export const deleteCalendarEventInput = z.object({
  // Optional CalDAV URL from list_calendars; defaults to the principal's
  // discovered default calendar (where create_calendar_event also lands).
  calendarUrl: z.url().optional(),
  uid: eventUidSchema,
})

export type DeleteCalendarEventArgs = z.infer<typeof deleteCalendarEventInput>

export interface DeleteCalendarEventDeps {
  deleteEvent: (params: DeleteEventParams) => Promise<void>
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>
}

export interface DeleteCalendarEventContext {
  args: DeleteCalendarEventArgs
  token: string
}

export const deleteCalendarEvent = async (
  deps: DeleteCalendarEventDeps,
  ctx: DeleteCalendarEventContext
): Promise<ToolResult> => {
  const { args, token } = ctx
  const account = await deps.discover(token)

  const resolved = resolveCalendarUrl(account, args.calendarUrl)
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === 'none'
        ? 'No calendar available to delete the event from.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }
  const calendarUrl = resolved.url

  const existing = await deps.fetchEvent({ calendarUrl, token, uid: args.uid })
  if (!existing) {
    return errorResult(`Event not found: ${args.uid}`)
  }

  await deps.deleteEvent({ token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  return textResult(`Event ${args.uid} deleted; Stalwart will send cancellations to any attendees.`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): DeleteCalendarEventDeps => ({
  deleteEvent: (params) => deleteEvent(cfg, params),
  discover: (token) => discoverAccount(cfg, token),
  fetchEvent: (params) => fetchEvent(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerDeleteCalendarEvent = (
  server: McpServer,
  deps: DeleteCalendarEventDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'delete_calendar_event',
    {
      description:
        'Deletes a calendar event (identified by its uid from create_calendar_event) ' +
        'and sends iMIP cancellations to its attendees. Defaults to the user’s default ' +
        'calendar; pass calendarUrl if the event lives in another calendar.',
      inputSchema: deleteCalendarEventInput.shape,
      title: 'Delete calendar event',
    },
    (args) => {
      const parsed = deleteCalendarEventInput.parse(args)
      return deleteCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
