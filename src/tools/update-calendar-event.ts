// update_calendar_event tool — replaces an existing VEVENT in place and
// re-sends DKIM-signed iMIP invitations with a bumped SEQUENCE, so the
// attendees' clients treat it as an update rather than a new invite.
//
// The edit is a full re-specification of the event (title/time/attendees),
// addressed by the stable UID returned from create_calendar_event. We fetch
// the current object to confirm it exists, read its SEQUENCE, and PUT the
// rebuilt iCal back to the same URL with the original ETag.
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + updateEvent)
// so it unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { CalDavConfig, FetchEventParams, UpdateEventParams } from '../caldav/client.ts'
import { discoverAccount, fetchEvent, resolveCalendarUrl, updateEvent } from '../caldav/client.ts'
import { buildInvite, parseSequence } from '../caldav/ical.ts'
import type { CalendarObject, DiscoveredAccount } from '../caldav/types.ts'
import { createCalendarEventInput, eventUidSchema } from './create-calendar-event.ts'
import type { ToolResult } from './result.ts'
import { errorResult, textResult } from './result.ts'

export const updateCalendarEventInput = createCalendarEventInput.extend({
  uid: eventUidSchema,
})

export type UpdateCalendarEventArgs = z.infer<typeof updateCalendarEventInput>

export interface UpdateCalendarEventDeps {
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>
  updateEvent: (params: UpdateEventParams) => Promise<void>
}

export interface UpdateCalendarEventContext {
  args: UpdateCalendarEventArgs
  token: string
}

export const updateCalendarEvent = async (
  deps: UpdateCalendarEventDeps,
  ctx: UpdateCalendarEventContext
): Promise<ToolResult> => {
  const { args, token } = ctx
  const account = await deps.discover(token)

  if (!account.organizer) {
    return errorResult('Could not determine an organizer address for this account.')
  }

  const resolved = resolveCalendarUrl(account, args.calendarUrl)
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === 'none'
        ? 'No calendar available to update the event in.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }
  const calendarUrl = resolved.url

  const start = new Date(args.start)
  const end = new Date(args.end)
  if (end <= start) {
    return errorResult('Event end must be after its start.')
  }

  const existing = await deps.fetchEvent({ calendarUrl, token, uid: args.uid })
  if (!existing) {
    return errorResult(`Event not found: ${args.uid}`)
  }

  const ical = buildInvite({
    attendees: args.attendees,
    end,
    organizer: account.organizer,
    // Bump past the stored SEQUENCE so the re-sent REQUEST supersedes it.
    sequence: parseSequence(existing.data) + 1,
    start,
    title: args.title,
    uid: args.uid,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
  })

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  return textResult(
    `Event "${args.title}" updated and notifications sent to ${args.attendees.length} ` +
      `attendee(s): ${args.attendees.join(', ')}.`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): UpdateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  fetchEvent: (params) => fetchEvent(params),
  updateEvent: (params) => updateEvent(params),
})

// --- MCP registration ----------------------------------------------------

export const registerUpdateCalendarEvent = (
  server: McpServer,
  deps: UpdateCalendarEventDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'update_calendar_event',
    {
      description:
        'Updates an existing calendar event in place (identified by its uid from ' +
        'create_calendar_event) and re-sends iMIP notifications to the attendees. ' +
        'This is a full replacement: pass the complete event details, not just the ' +
        'changed fields. Times are ISO 8601 with offset (e.g. 2026-06-12T10:00:00Z).',
      inputSchema: updateCalendarEventInput.shape,
      title: 'Update calendar event',
    },
    (args) => {
      const parsed = updateCalendarEventInput.parse(args)
      return updateCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
