// create_calendar_event tool — builds a VEVENT (METHOD:REQUEST) with the
// authenticated principal as ORGANIZER and PUTs it to a CalDAV calendar.
// Stalwart then fans out DKIM-signed iMIP invitations to the attendees.
//
// Logic sits behind a `Deps` interface (discover + putEvent) so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type AccountTimeZoneResolver, makeAccountTimeZoneResolver } from '../caldav/account-settings.ts'
import {
  type CalDavConfig,
  discoverAccount,
  type PutEventParams,
  putEvent,
  resolveCalendarUrl,
} from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { recurrenceDescription, recurrenceSchema, toRRule } from '../caldav/recurrence.ts'
import {
  dateTimeWithOptionalOffsetSchema,
  resolveInputDateTime,
  timeZoneSchema,
  UTC_TIME_ZONE,
} from '../caldav/timezone.ts'
import { type DiscoveredAccount } from '../caldav/types.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

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
  end: dateTimeWithOptionalOffsetSchema.describe(
    'Event end as ISO 8601. With explicit `timeZone`, the clock digits are interpreted in that zone and any embedded offset is ignored. Without `timeZone`, an offset fixes the instant; a naive value uses the account timezone fallback.'
  ),
  location: z.string().max(500).optional(),
  recurrence: recurrenceSchema.describe(recurrenceDescription).optional(),
  start: dateTimeWithOptionalOffsetSchema.describe(
    'Event start as ISO 8601. With explicit `timeZone`, the clock digits are interpreted in that zone and any embedded offset is ignored. Without `timeZone`, an offset fixes the instant; a naive value uses the account timezone fallback.'
  ),
  timeZone: timeZoneSchema
    .optional()
    .describe(
      'Optional IANA timezone, e.g. Europe/Berlin. Overrides offsets in start/end: the clock digits are treated as wall-clock time in this zone. Defaults to the account timezone preference, then UTC.'
    ),
  title: z.string().min(1).max(200),
})

export type CreateCalendarEventArgs = z.infer<typeof createCalendarEventInput>

export interface CreateCalendarEventDeps {
  discover: (token: string) => Promise<DiscoveredAccount>
  putEvent: (params: PutEventParams) => Promise<void>
  // Stored default zone (Stalwart AccountSettings.timeZone), consulted only when
  // the caller omits `timeZone`. Shared across the calendar tools — see mcp/handler.ts.
  resolveTimeZone: AccountTimeZoneResolver
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

  const timeZone = args.timeZone ?? (await deps.resolveTimeZone(token)) ?? UTC_TIME_ZONE
  const start = resolveInputDateTime(args.start, timeZone, args.timeZone !== undefined)
  const end = resolveInputDateTime(args.end, timeZone, args.timeZone !== undefined)
  if (end <= start) {
    return errorResult('Event end must be after its start.')
  }

  const rrule = args.recurrence ? toRRule(args.recurrence) : undefined
  const uid = `${crypto.randomUUID()}@${domainOf(account.organizer)}`
  const ical = buildInvite({
    attendees: args.attendees,
    end,
    organizer: account.organizer,
    start,
    timeZone,
    title: args.title,
    uid,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
    ...(rrule ? { rrule } : {}),
  })

  await deps.putEvent({ calendarUrl, ical, token, uid })

  return textResult(
    `${rrule ? 'Recurring event' : 'Event'} "${args.title}" created and invitations sent ` +
      `to ${args.attendees.length} attendee(s): ${args.attendees.join(', ')}.\n` +
      // Surface the UID + calendar so a later turn can update_calendar_event /
      // delete_calendar_event this event.
      `uid: ${uid}\ncalendarUrl: ${calendarUrl}`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
  cfg: CalDavConfig,
  // Shared across the calendar tools (see mcp/handler.ts) so create→update reuse
  // one per-token cache; defaults to a fresh resolver for standalone callers.
  resolveTimeZone: AccountTimeZoneResolver = makeAccountTimeZoneResolver({ serverUrl: cfg.serverUrl })
): CreateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  putEvent: (params) => putEvent(cfg, params),
  resolveTimeZone,
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
        'or naive local form. Optional `timeZone` is an IANA zone and, when passed, ' +
        'overrides embedded offsets so wall-clock digits win. Pass `recurrence` to create a repeating series ' +
        '(e.g. a weekly team meeting) in a single call. Defaults to the user’s ' +
        'default calendar.',
      inputSchema: createCalendarEventInput.shape,
      title: 'Create calendar event',
    },
    (args) => {
      const parsed = createCalendarEventInput.parse(args)
      return createCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
