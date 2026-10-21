// list_calendar_events tool — lists what is on a calendar: within a time
// range, every occurrence that falls inside it at its actual time (see
// caldav/agenda.ts); without one, every stored event and series once. Each entry
// carries the uid (and, for an occurrence, the recurrenceId) that
// update_calendar_event / delete_calendar_event address it by.
//
// Logic sits behind a `Deps` interface (discover + fetchEvents) so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type ParsedEvent, parseEvents } from '@langmail/ical'

import { type AgendaEntry, storedEntries, windowEntries } from '../caldav/agenda.ts'
import { describeAlarm } from '../caldav/alarm.ts'
import {
  type CalDavConfig,
  discoverAccount,
  type FetchEventsParams,
  fetchEvents,
  resolveCalendarUrl,
} from '../caldav/client.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { READ_ONLY } from './annotations.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

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

// `email` for an unanswered invitee, `email (accepted)` once they respond.
// NEEDS-ACTION is the default and adds no signal, so it's left unannotated.
const formatAttendee = (attendee: ParsedEvent['attendees'][number]): string =>
  attendee.status && attendee.status.toUpperCase() !== 'NEEDS-ACTION'
    ? `${attendee.email} (${attendee.status.toLowerCase()})`
    : attendee.email

// The `when:` value. An all-day event prints its dates exactly as stored and
// as create/update accept them — no invented clock time — and says the end is
// exclusive, since `2026-10-03 → 2026-10-04` otherwise reads as two days.
const formatWhen = (ev: ParsedEvent): string => {
  const range = ev.end ? `${ev.start} → ${ev.end}` : ev.start
  if (ev.allDay) {
    return ev.end ? `${range} (all day; end date exclusive)` : `${range} (all day)`
  }
  // Surface the event's own zone so a naive `…T10:00:00` (a TZID event) isn't
  // silently read as UTC; a UTC event carries its `Z` and needs no annotation.
  return ev.startTzid ? `${range} (${ev.startTzid})` : range
}

// `2026-10-20T14:00:00.000Z` → `2026-10-20T14:00:00Z`, or the date for an
// all-day series: the form update_calendar_event and delete_calendar_event take.
const MILLIS_RE = /\.000Z$/u
const formatRecurrenceId = (ev: ParsedEvent, recurrenceId: string): string =>
  ev.allDay ? recurrenceId.slice(0, 10) : recurrenceId.replace(MILLIS_RE, 'Z')

// The original start a moved occurrence left, in the same form as `when:`.
const formatMovedFrom = (ev: ParsedEvent, movedFrom: string): string =>
  !ev.allDay && ev.startTzid ? `${movedFrom} (${ev.startTzid})` : movedFrom

// Says whether the organizer is the user, so an organizer's own blank reply
// status doesn't read as an invitation they haven't answered.
const formatOrganizer = (organizer: string, self: string | null): string =>
  self && organizer.toLowerCase() === self.toLowerCase() ? `${organizer} (you)` : organizer

const formatEvent = (idx: number, entry: AgendaEntry, self: string | null): string => {
  const ev = entry.event
  const lines = [`${idx}. ${ev.title || '(no title)'}`, `   when: ${formatWhen(ev)}`]
  if (entry.movedFrom) {
    lines.push(`   moved from: ${formatMovedFrom(ev, entry.movedFrom)}`)
  }
  if (ev.location) {
    lines.push(`   location: ${ev.location}`)
  }
  if (ev.recurrence) {
    lines.push(`   repeats: ${ev.recurrence}`)
  }
  if (ev.recurrenceId) {
    lines.push(`   recurrenceId: ${formatRecurrenceId(ev, ev.recurrenceId)}`)
  }
  const alarms = ev.alarms ?? []
  if (alarms.length > 0) {
    lines.push(
      `   ${alarms.length === 1 ? 'reminder' : 'reminders'}: ${alarms.map((a) => describeAlarm(a, ev.allDay === true)).join(', ')}`
    )
  }
  if (ev.organizer) {
    lines.push(`   organizer: ${formatOrganizer(ev.organizer, self)}`)
  }
  // The attendee list is what makes an attendee edit safe: it's the current
  // stored membership update_calendar_event mutates, read straight from Langmail.
  if (ev.attendees.length > 0) {
    lines.push(`   attendees: ${ev.attendees.map(formatAttendee).join(', ')}`)
  }
  lines.push(`   uid: ${ev.uid}`)
  return lines.join('\n')
}

// A window like a year of a daily series could list hundreds of occurrences.
const MAX_ENTRIES = 200

// The UTC offset written on an ISO 8601 date-time (`Z`, `+02:00`), in ms.
const OFFSET_RE = /([+-])(\d{2}):(\d{2})$/u
const offsetMs = (iso: string): number => {
  const match = OFFSET_RE.exec(iso)
  if (!match) {
    return 0
  }
  const [, sign, hours, minutes] = match
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000
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

  const window =
    args.start && args.end
      ? { allDayOffsetMs: offsetMs(args.start), end: new Date(args.end), start: new Date(args.start) }
      : undefined
  const objects = await deps.fetchEvents({
    calendarUrl: resolved.url,
    token,
    ...(args.start && args.end ? { timeRange: { end: args.end, start: args.start } } : {}),
  })

  // An all-day entry starts at the caller's midnight, not UTC's.
  const sortKey = (entry: AgendaEntry): number =>
    entry.startMs - (entry.event.allDay ? (window?.allDayOffsetMs ?? 0) : 0)
  // Series are expanded per calendar object: a master and its overrides share one.
  const entries = objects
    .flatMap((o) => {
      const events = parseEvents(o.data)
      return window ? windowEntries(events, window) : storedEntries(events)
    })
    .sort((a, b) => sortKey(a) - sortKey(b) || a.event.title.localeCompare(b.event.title))
  if (entries.length === 0) {
    return textResult(window ? `No events between ${args.start} and ${args.end}.` : 'No events found.')
  }

  const shown = entries.slice(0, MAX_ENTRIES)
  const lines = shown.map((entry, i) => formatEvent(i + 1, entry, account.organizer))
  const heading = window
    ? `${entries.length} event(s) between ${args.start} and ${args.end}, each occurrence of a series at its own time:`
    : `${entries.length} event(s), each series once at its first occurrence:`
  const truncated =
    entries.length > MAX_ENTRIES ? `\n\nShowing the first ${MAX_ENTRIES}. Narrow start/end to see the rest.` : ''
  return textResult(`${heading}\n\n${lines.join('\n\n')}${truncated}`)
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
      annotations: READ_ONLY,
      description:
        'Read the user’s calendar, agenda or schedule — what’s on their calendar, what meetings they ' +
        'have, when they are busy or free. With a start/end window (ISO 8601 with offset, both or neither), ' +
        'lists every event and every occurrence of a repeating series that falls inside it, each at its ' +
        'actual date and time; a moved occurrence says when it originally was. Without a window it lists ' +
        'each stored event once, a series at its first occurrence with its repeat rule — use a window to ' +
        'answer "what is on day X". Each entry has its title, time (dates only for all-day events), ' +
        'location, reminders, organizer (marked "(you)" when it is the user), attendees with their ' +
        'response status for that occurrence, uid, and for an occurrence its recurrenceId. Pass the uid ' +
        '(and recurrenceId, to touch one occurrence only) to update_calendar_event or ' +
        'delete_calendar_event; the returned attendee list is the current membership those tools edit, ' +
        'so read it here before removing or adding attendees rather than guessing. Defaults to the ' +
        'user’s default calendar. Birthdays are not calendar events here; for upcoming birthdays use ' +
        'list_upcoming_birthdays.',
      inputSchema: listCalendarEventsInput.shape,
      title: 'List calendar events',
    },
    (args) => {
      const parsed = listCalendarEventsInput.parse(args)
      return listCalendarEvents(deps, { args: parsed, token: getToken() })
    }
  )
}
