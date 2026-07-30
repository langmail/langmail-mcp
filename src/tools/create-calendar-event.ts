// create_calendar_event tool — builds a VEVENT (METHOD:REQUEST) with the
// authenticated principal as ORGANIZER and PUTs it to a CalDAV calendar.
// Stalwart then fans out DKIM-signed iMIP invitations to the attendees, if
// any: an attendee-less VEVENT is a personal event (a block of the user's
// own time) and triggers no scheduling at all.
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
import { OUTWARD_WRITE } from './annotations.ts'
import { type AttendeeWriteThrough } from './contact-write-through.ts'
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
  attendees: z
    .array(z.email())
    .max(50)
    .optional()
    .describe(
      'Email addresses to invite; each receives an iMIP invitation. Omit for a personal event — a block ' +
        'of the user’s own time — with no invitations sent.'
    ),
  // Optional CalDAV URL from list_calendars; defaults to the principal's
  // discovered default calendar.
  calendarUrl: z.url().optional(),
  description: z.string().max(5000).optional(),
  // The timezone rule is stated once, on `timeZone`, rather than repeated on
  // start/end: all three strings are indexed by tool search.
  end: dateTimeWithOptionalOffsetSchema.describe('Event end as ISO 8601 (see `timeZone`).'),
  location: z.string().max(500).optional(),
  notify: z
    .enum(['all', 'none'])
    .optional()
    .describe('Whether to send the iMIP invitations. `all` (default) sends them; `none` invites nobody.'),
  recurrence: recurrenceSchema
    .describe(`Repeat rule; omit for a one-off event. start/end are its first occurrence. ${recurrenceDescription}`)
    .optional(),
  start: dateTimeWithOptionalOffsetSchema.describe('Event start as ISO 8601 (see `timeZone`).'),
  timeZone: timeZoneSchema
    .optional()
    .describe(
      'IANA zone for start/end, e.g. Europe/Berlin: their clock digits are read as wall-clock time here, ' +
        'overriding any offset. Defaults to the account timezone, then UTC.'
    ),
  title: z.string().min(1).max(200),
})

export type CreateCalendarEventArgs = z.infer<typeof createCalendarEventInput>

export interface CreateCalendarEventDeps {
  // Upserts the attendees into the collected address book after a successful
  // PUT (never throws — see contact-write-through.ts). Optional so
  // standalone/test callers can omit it.
  collectAttendees?: AttendeeWriteThrough
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

// One-line human summary of who the PUT invited (create-side counterpart of
// update-calendar-event's deliverySummary).
const deliverySummary = (attendees: string[], notify: 'all' | 'none' | undefined): string => {
  if (attendees.length === 0) {
    return 'no attendees, no invitations sent'
  }
  const roster = `${attendees.length} attendee(s): ${attendees.join(', ')}`
  return notify === 'none' ? `no invitations sent to the ${roster}` : `invitations sent to ${roster}`
}

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
  // No attendees → a personal event: the VEVENT carries only the ORGANIZER, so
  // Stalwart's scheduler has nobody to fan an iMIP invitation out to.
  const attendees = args.attendees ?? []
  const uid = `${crypto.randomUUID()}@${domainOf(account.organizer)}`
  const ical = buildInvite({
    attendees,
    end,
    organizer: account.organizer,
    start,
    timeZone,
    title: args.title,
    uid,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
    ...(rrule ? { rrule } : {}),
    ...(args.notify === 'none' ? { scheduleAgent: 'NONE' as const } : {}),
  })

  await deps.putEvent({ calendarUrl, ical, token, uid })

  await deps.collectAttendees?.({
    attendees: attendees.map((email) => ({ email })),
    organizer: account.organizer,
    selfAddress: account.organizer,
    start: start.toISOString(),
    token,
    uid,
  })

  return textResult(
    `${rrule ? 'Recurring event' : 'Event'} "${args.title}" created (${deliverySummary(attendees, args.notify)}).\n` +
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
  resolveTimeZone: AccountTimeZoneResolver = makeAccountTimeZoneResolver({ serverUrl: cfg.serverUrl }),
  collectAttendees?: AttendeeWriteThrough
): CreateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  putEvent: (params) => putEvent(cfg, params),
  resolveTimeZone,
  ...(collectAttendees ? { collectAttendees } : {}),
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
      annotations: OUTWARD_WRITE,
      // Front-loaded with what a user types to want this tool ("schedule a
      // meeting", "book", "invite", "put it on my calendar"); the specification
      // detail lives on the docs site, because this string is indexed by tool
      // search and length costs ranking.
      description:
        'Create, schedule or book a new calendar event or meeting on the user’s calendar, with the ' +
        'authenticated user as organizer, and invite people to it. Attendees receive iMIP invitations ' +
        '(pass `notify: "none"` to suppress them); omit `attendees` for a personal event — a block of the ' +
        'user’s own time. Pass `recurrence` for a repeating series (e.g. a weekly team meeting) in one ' +
        'call. Defaults to the user’s default calendar.',
      inputSchema: createCalendarEventInput.shape,
      title: 'Create calendar event',
    },
    (args) => {
      const parsed = createCalendarEventInput.parse(args)
      return createCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
