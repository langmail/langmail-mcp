// create_calendar_event tool — builds a VEVENT (METHOD:REQUEST) with the
// authenticated principal as ORGANIZER and PUTs it to a CalDAV calendar.
// Stalwart then fans out DKIM-signed iMIP invitations to the attendees.
//
// Logic sits behind a `Deps` interface (discover + putEvent) so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { CalDavConfig, PutEventParams } from '../caldav/client.ts'
import { discoverAccount, putEvent, resolveCalendarUrl } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import type { DiscoveredAccount } from '../caldav/types.ts'
import type { ToolResult } from './result.ts'
import { errorResult, textResult } from './result.ts'

// An event's iCalendar UID, as returned by create_calendar_event. Rejects
// path separators: create names the `.ics` resource `${uid}.ics` on PUT (see
// putEvent), so a `/` or `\` could otherwise escape the validated calendar
// collection. (Reads no longer depend on the filename — they match by UID —
// but the create-side PUT still does.)
export const eventUidSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\]+$/u, 'uid must not contain path separators')

export const createCalendarEventInput = z.object({
  attendees: z.array(z.email()).min(1).max(50),
  // Optional CalDAV URL from list_calendars; defaults to the principal's
  // discovered default calendar.
  calendarUrl: z.url().optional(),
  description: z.string().max(5000).optional(),
  end: z.iso.datetime({ offset: true }),
  location: z.string().max(500).optional(),
  start: z.iso.datetime({ offset: true }),
  title: z.string().min(1).max(200),
})

export type CreateCalendarEventArgs = z.infer<typeof createCalendarEventInput>

export interface CreateCalendarEventDeps {
  discover: (token: string) => Promise<DiscoveredAccount>
  putEvent: (params: PutEventParams) => Promise<void>
}

export interface CreateCalendarEventContext {
  args: CreateCalendarEventArgs
  token: string
}

const domainOf = (email: string): string => email.split('@')[1] ?? 'langmail.me'

export const createCalendarEvent = async (
  deps: CreateCalendarEventDeps,
  ctx: CreateCalendarEventContext
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
        ? 'No calendar available to create the event in.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }
  const calendarUrl = resolved.url

  const start = new Date(args.start)
  const end = new Date(args.end)
  if (end <= start) {
    return errorResult('Event end must be after its start.')
  }

  const uid = `${crypto.randomUUID()}@${domainOf(account.organizer)}`
  const ical = buildInvite({
    attendees: args.attendees,
    end,
    organizer: account.organizer,
    start,
    title: args.title,
    uid,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
  })

  await deps.putEvent({ calendarUrl, ical, token, uid })

  return textResult(
    `Event "${args.title}" created and invitations sent to ${args.attendees.length} ` +
      `attendee(s): ${args.attendees.join(', ')}.\n` +
      // Surface the UID + calendar so a later turn can update_calendar_event /
      // delete_calendar_event this event.
      `uid: ${uid}\ncalendarUrl: ${calendarUrl}`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): CreateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  putEvent: (params) => putEvent(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerCreateCalendarEvent = (
  server: McpServer,
  deps: CreateCalendarEventDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'create_calendar_event',
    {
      description:
        'Creates a calendar event and sends iMIP invitations to the attendees, ' +
        'with the authenticated user as organizer. Times are ISO 8601 with offset ' +
        '(e.g. 2026-06-12T10:00:00Z). Defaults to the user’s default calendar.',
      inputSchema: createCalendarEventInput.shape,
      title: 'Create calendar event',
    },
    (args) => {
      const parsed = createCalendarEventInput.parse(args)
      return createCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
