// create_calendar_event tool — builds a VEVENT and PUTs it to a CalDAV
// calendar. With attendees it is a scheduling object (METHOD:REQUEST, the
// authenticated principal as ORGANIZER) and Stalwart fans out DKIM-signed
// iMIP invitations to them. Without, it is a personal event — a block of the
// user's own time — carrying neither METHOD nor ORGANIZER, and triggers no
// scheduling at all.
//
// Logic sits behind a `Deps` interface (discover + putEvent) so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { type AccessLevel, reachesOthers } from '../access/levels.ts'
import { type AccountTimeZoneResolver, makeAccountTimeZoneResolver } from '../caldav/account-settings.ts'
import { describeReminder, MAX_REMINDER_MINUTES } from '../caldav/alarm.ts'
import {
  type CalDavConfig,
  discoverAccount,
  type PutEventParams,
  putEvent,
  resolveCalendarUrl,
} from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { alignUntil, recurrenceDescription, recurrenceSchema, toRRule } from '../caldav/recurrence.ts'
import { logSchedulingHandover } from '../caldav/scheduling-handover.ts'
import { eventTimeSchema, resolveEventTimes, timeZoneSchema, UTC_TIME_ZONE } from '../caldav/timezone.ts'
import { type DiscoveredAccount } from '../caldav/types.ts'
import { ACCOUNT_WRITE, OUTWARD_WRITE } from './annotations.ts'
import { type AttendeeWriteThrough } from './contact-write-through.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const TOOL_NAME = 'create_calendar_event'

// An event's iCalendar UID, as accepted by the update/delete/RSVP tools and
// returned by create_calendar_event. Deliberately permissive: it must keep
// accepting the legacy `<uuid>@<domain>` form, because events created before
// the UID became a bare UUID are still addressed by those UIDs.
//
// Path separators stay rejected. No code path derives a resource URL from a
// UID any more (resources are resolved by parsed VEVENT UID, and created under
// an independently generated name — see newEventResourceName), so this is
// defence in depth rather than the load-bearing guard it once was.
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
  //
  // All-day is expressed by the value type (a bare date), not an `allDay`
  // flag: a flag would make `allDay: true` + a clock time representable, and
  // an update would need a third "keep" state. See resolveEventTimes.
  end: eventTimeSchema.describe(
    'Event end as ISO 8601 (see `timeZone`). For an all-day event a date, exclusive: the day after the ' +
      'last day (a day off on 2026-10-03 ends 2026-10-04).'
  ),
  location: z.string().max(500).optional(),
  notify: z
    .enum(['all', 'none'])
    .optional()
    .describe('Whether to send the iMIP invitations. `all` (default) sends them; `none` invites nobody.'),
  recurrence: recurrenceSchema
    .describe(`Repeat rule; omit for a one-off event. start/end are its first occurrence. ${recurrenceDescription}`)
    .optional(),
  reminderMinutesBefore: z
    .number()
    .int()
    .min(0)
    .max(MAX_REMINDER_MINUTES)
    .optional()
    .describe(
      'Remind the user this many minutes before the start (e.g. 30); omit for no reminder. An all-day event ' +
        'starts at 00:00, so 900 = 09:00 the day before.'
    ),
  showAs: z
    .enum(['busy', 'free'])
    .optional()
    .describe(
      'Whether this event counts as busy time. `busy` (default) means it does; `free` means it does not — ' +
        'for holds, reminders and travel buffers the user does not want counted against their availability. ' +
        'Inviting people makes an event count as busy time, so `free` is refused when `attendees` are given.'
    ),
  start: eventTimeSchema.describe(
    'Event start as ISO 8601 (see `timeZone`), or a date (2026-10-03) for an all-day event.'
  ),
  timeZone: timeZoneSchema
    .optional()
    .describe(
      'IANA zone for start/end, e.g. Europe/Berlin: their clock digits are read as wall-clock time here, ' +
        'overriding any offset. Defaults to the account timezone, then UTC.'
    ),
  title: z.string().min(1).max(200),
})

export type CreateCalendarEventArgs = z.infer<typeof createCalendarEventInput>

// The form an agent at Change, never send gets (src/access/levels.ts): a
// personal event only, so no attendees and nothing to notify. Strict, so an
// agent still holding the full form from a cached tool list gets its attendees
// refused instead of silently dropped.
export const createPersonalEventInput = z.strictObject({
  ...createCalendarEventInput.omit({ attendees: true, notify: true }).shape,
  showAs: z
    .enum(['busy', 'free'])
    .optional()
    .describe(
      'Whether this event counts as busy time. `busy` (default) means it does; `free` means it does not, ' +
        'for holds, reminders and travel buffers the user does not want counted against their availability.'
    ),
})

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

// One-line human summary of who the PUT invited (create-side counterpart of
// update-calendar-event's deliverySummary).
const deliverySummary = (
  attendees: string[],
  notify: 'all' | 'none' | undefined,
  allDay: boolean,
  reminder?: number
): string => {
  const invites = inviteSummary(attendees, notify)
  return reminder === undefined ? invites : `${invites}; reminder ${describeReminder(reminder, allDay)}`
}

const inviteSummary = (attendees: string[], notify: 'all' | 'none' | undefined): string => {
  if (attendees.length === 0) {
    return 'no attendees, no invitations'
  }
  // The CalDAV write is all this tool sees; Stalwart sends the iMIP mail
  // afterwards and may fail or skip it, so say "requested", never "sent".
  const roster = `${attendees.length} attendee(s): ${attendees.join(', ')}`
  return notify === 'none' ? `invitations suppressed for the ${roster}` : `invitations requested for ${roster}`
}

// "Event", "Recurring event", "All-day event", "Recurring all-day event".
const eventNoun = (allDay: boolean, recurring: boolean): string => {
  const noun = `${recurring ? 'recurring ' : ''}${allDay ? 'all-day ' : ''}event`
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`
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
  const times = resolveEventTimes(args.start, args.end, timeZone, args.timeZone !== undefined)
  if (!times.ok) {
    return errorResult(`${times.error} Nothing was created.`)
  }
  const { allDay, end, start } = times.value

  const rrule = args.recurrence ? alignUntil(toRRule(args.recurrence), allDay, timeZone) : undefined
  // No attendees → a personal event: a block of the user's own time rather
  // than a scheduling object, so the VEVENT gets neither METHOD nor ORGANIZER
  // and Stalwart's scheduler has nothing to fan out.
  //
  // Create is the only caller that may omit the ORGANIZER. An *edit* that
  // leaves an event with no attendees must still name one — see the field's
  // comment on InviteInput for the two ways that goes silently wrong.
  const attendees = args.attendees ?? []
  const isSchedulingObject = attendees.length > 0
  // In a meeting each attendee decides their own free/busy, and the stored
  // event is also the invitation they receive, so a meeting cannot be marked
  // free. `busy` is the RFC default and changes nothing for them.
  if (isSchedulingObject && args.showAs === 'free') {
    return errorResult(
      'An event with attendees cannot be marked `showAs: "free"`: inviting people makes it count as busy time. ' +
        'Nothing was created. Omit `showAs` to create the meeting, or omit `attendees` for a free personal event.'
    )
  }
  // A bare UUID: RFC 7986 §5.3 (2016) supersedes the RFC 5545 advice to
  // qualify a UID with a domain — it MUST NOT carry host or domain data. Side
  // benefit: the mail domain no longer leaks into every invitation sent to an
  // external attendee.
  const uid = crypto.randomUUID()
  const ical = buildInvite({
    allDay,
    attendees,
    end,
    start,
    timeZone,
    title: args.title,
    uid,
    ...(isSchedulingObject ? { organizer: account.organizer } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
    ...(rrule ? { rrule } : {}),
    ...(args.showAs ? { showAs: args.showAs } : {}),
    ...(args.notify === 'none' ? { scheduleAgent: 'NONE' as const } : {}),
    ...(args.reminderMinutesBefore === undefined ? {} : { alarms: [{ minutesBefore: args.reminderMinutesBefore }] }),
  })

  await deps.putEvent({ calendarUrl, ical, token })
  // A personal event hands Stalwart nothing to schedule, so only a scheduling
  // object gets the audit line.
  if (isSchedulingObject) {
    logSchedulingHandover({
      attendees,
      ical,
      removedAttendees: [],
      scheduleAgent: args.notify === 'none' ? 'NONE' : undefined,
      // buildInvite emits no SEQUENCE, so the RFC 5545 default of 0 applies.
      sequence: 0,
      tool: TOOL_NAME,
      uid,
    })
  }

  await deps.collectAttendees?.({
    attendees: attendees.map((email) => ({ email })),
    organizer: account.organizer,
    selfAddress: account.organizer,
    start: start.toISOString(),
    token,
    uid,
  })

  return textResult(
    `${eventNoun(allDay, rrule !== undefined)} "${args.title}" created ` +
      `(${deliverySummary(attendees, args.notify, allDay, args.reminderMinutesBefore)}).\n` +
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
  getToken: () => string,
  access: AccessLevel
): void => {
  if (!reachesOthers(access)) {
    server.registerTool(
      TOOL_NAME,
      {
        annotations: ACCOUNT_WRITE,
        description:
          'Create or book a personal event on the user’s calendar: a block of their own time that nobody ' +
          'else is on, such as an appointment, a reminder or a trip. Inviting people to a meeting needs ' +
          'Everything access. For an all-day event (a day off, a vacation) pass `start`/`end` as dates. ' +
          'Pass `recurrence` for a repeating series in one call, and `reminderMinutesBefore` to be ' +
          'reminded. Defaults to the user’s default calendar.',
        inputSchema: createPersonalEventInput,
        title: 'Create calendar event',
      },
      (args) => createCalendarEvent(deps, { args: createPersonalEventInput.parse(args), token: getToken() })
    )
    return
  }
  server.registerTool(
    TOOL_NAME,
    {
      annotations: OUTWARD_WRITE,
      // Front-loaded with what a user types to want this tool ("schedule a
      // meeting", "book", "invite", "put it on my calendar"); the specification
      // detail lives on the docs site, because this string is indexed by tool
      // search and length costs ranking.
      description:
        'Create, schedule or book a new calendar event or meeting on the user’s calendar, and invite ' +
        'people to it with the authenticated user as organizer. Attendees receive iMIP invitations ' +
        '(pass `notify: "none"` to suppress them); omit `attendees` for a personal event — a block of the ' +
        'user’s own time. For an all-day event (a day off, a vacation) pass `start`/`end` as ' +
        'dates. Pass `recurrence` for a repeating series (e.g. a weekly team meeting) in one call, and ' +
        '`reminderMinutesBefore` to be reminded. Defaults to the user’s default calendar.',
      inputSchema: createCalendarEventInput,
      title: 'Create calendar event',
    },
    (args) => {
      const parsed = createCalendarEventInput.parse(args)
      return createCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
