// Builds the iMIP invitation (VCALENDAR/VEVENT, METHOD:REQUEST) that we
// PUT to the principal's CalDAV calendar. `ical-generator` owns escaping,
// CRLF line-folding, and date formatting; this module just maps our
// invite shape onto it.

import { getVtimezoneComponent } from '@touch4it/ical-timezones'
import ical, {
  ICalAlarmType,
  type ICalAttendeeData,
  ICalAttendeeRole,
  ICalAttendeeStatus,
  ICalCalendarMethod,
  ICalEventTransparency,
} from 'ical-generator'

import { toZonedDate, UTC_TIME_ZONE } from './timezone.ts'

// An `Etc/GMT±N` zone name. The sign is POSIX's, the reverse of the offset:
// `Etc/GMT-13` is UTC+13.
const ETC_GMT_RE = /^Etc\/GMT([+-])(\d{1,2})$/u

// A fixed-offset VTIMEZONE for an `Etc/GMT±N` zone: one STANDARD component
// whose offset never changes. Returns null for any other name.
const etcGmtVtimezone = (name: string): string | null => {
  const match = ETC_GMT_RE.exec(name)
  if (!match) {
    return null
  }
  const [, posixSign, hours = '0'] = match
  // RFC 5545 §3.3.14 forbids `-0000`, so a zero offset is always `+`.
  const sign = posixSign === '+' && Number(hours) > 0 ? '-' : '+'
  const tzname = `${sign}${hours.padStart(2, '0')}`
  const offset = `${tzname}00`
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${name}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${tzname}`,
    'END:STANDARD',
    'END:VTIMEZONE',
    '',
  ].join('\n')
}

const TZID_LINE_RE = /^TZID:.*$/mu

// The VTIMEZONE for a zone the event names, under that same TZID (RFC 5545
// §3.6.5). `Etc/GMT±N` zones are written here: @touch4it/ical-timezones lacks
// Etc/GMT-13 and Etc/GMT-14 and ships the rest with the offset's sign flipped.
// Every other zone takes the library's definition, renamed to the requested
// TZID, because the library defines an alias (Asia/Calcutta) under another
// name (Asia/Kolkata). See
// docs/upstream/ical-timezones/etc-gmt-zones-have-inverted-offsets.md and
// docs/upstream/ical-timezones/alias-zones-defined-under-another-tzid.md.
export const vtimezoneComponent = (name: string): string | null =>
  etcGmtVtimezone(name) ?? getVtimezoneComponent(name)?.replace(TZID_LINE_RE, `TZID:${name}`) ?? null

const RECURRENCE_ID_LINE_RE = /^RECURRENCE-ID(?:;[^:]*)?:.*$/mu
// The DTSTAMP content line, with whatever params ical-generator attached.
// `buildInvite` always emits exactly one VEVENT, so the `g` flag is belt and
// braces rather than load-bearing; `String.replace` resets `lastIndex`, so
// sharing the regex across calls is safe (`.test`/`.exec` would not be).
//
// It follows that only output passing through here is restamped: a stored
// master's pre-existing floating DTSTAMP is healed by a whole-event rebuild,
// not by an occurrence edit, which splices the master across verbatim.
const DTSTAMP_LINE_RE = /^DTSTAMP(?:;[^:]*)?:.*$/gmu
// The start of each ATTENDEE content line (before its first param/value
// delimiter); multiline + global so every attendee is matched, folded
// continuation lines (leading space) are not.
const ATTENDEE_LINE_START_RE = /^ATTENDEE(?=[;:])/gmu
// The value-position `:MAILTO:` scheme, matched across a line fold (CRLF +
// space) between any two of its characters: ical-generator folds at 75
// octets, and a CN on the ATTENDEE pushes the scheme right onto the fold.
const UPPERCASE_MAILTO_RE = new RegExp([...':MAILTO:'].join(String.raw`(?:\r\n )?`), 'gu')

// A VALARM on the built VEVENT. `minutesBefore` writes a fresh DISPLAY alarm
// that fires that many minutes before the start (the reminder the tools
// accept); `lines` is a stored VALARM carried across an edit verbatim (its
// unfolded content lines, BEGIN/END inclusive — see ParsedAlarm), so an alarm
// another client wrote survives a rebuild in whatever shape it had.
export type InviteAlarm = { lines: string[] } | { minutesBefore: number }

// The END:VEVENT line; buildInvite emits exactly one VEVENT, so the first match
// is the only one.
const END_VEVENT_RE = /^END:VEVENT$/mu
const CRLF = '\r\n'
// RFC 5545 §3.1: content lines SHOULD NOT exceed 75 octets.
const MAX_LINE_OCTETS = 75

// Folds one unfolded content line at 75 octets (continuations start with a
// space, which counts toward their own limit). Splits on code points so a
// multi-byte character is never cut in half.
export const foldLine = (line: string): string => {
  const encoder = new TextEncoder()
  const out: string[] = []
  let current = ''
  let octets = 0
  for (const ch of line) {
    const size = encoder.encode(ch).length
    if (octets + size > MAX_LINE_OCTETS) {
      out.push(current)
      current = ' '
      octets = 1
    }
    current += ch
    octets += size
  }
  out.push(current)
  return out.join(CRLF)
}

// One ATTENDEE on the built VEVENT. A bare email string is a fresh invitee:
// NEEDS-ACTION, REQ-PARTICIPANT, no CN. The object form carries a stored
// attendee's reply, display name and role across an edit (RFC 5546 §3.2.2.2:
// a non-rescheduling update keeps each reply). `status`/`role` are the raw
// PARTSTAT/ROLE values; an unknown value falls back to the default.
export type InviteAttendee = string | { email: string; name?: string; role?: string; status?: string }

const ATTENDEE_STATUSES: ReadonlyMap<string, ICalAttendeeStatus> = new Map(
  Object.values(ICalAttendeeStatus).map((status) => [status, status])
)
const ATTENDEE_ROLES: ReadonlyMap<string, ICalAttendeeRole> = new Map(
  Object.values(ICalAttendeeRole).map((role) => [role, role])
)

const TRANSPARENCY: Record<'busy' | 'free', ICalEventTransparency> = {
  busy: ICalEventTransparency.OPAQUE,
  free: ICalEventTransparency.TRANSPARENT,
}

export interface InviteInput {
  // VALARMs to attach, in order. See InviteAlarm.
  alarms?: InviteAlarm[]
  // An all-day event: DTSTART/DTEND are written as DATE values
  // (`DTSTART;VALUE=DATE:20261003`) and `end` is exclusive — the day after the
  // last day (RFC 5545 §3.6.1). `start`/`end` must then be UTC midnights (see
  // dateOnlyToInstant); `timeZone` is ignored, since dates are floating.
  allDay?: boolean
  attendees: InviteAttendee[]
  description?: string
  end: Date
  location?: string
  // Bare organizer email (no `mailto:`), the authenticated principal. Omit it
  // to emit no ORGANIZER at all, which a *freshly created* personal event
  // does: with no attendees it is not a scheduling object, so it needs
  // neither METHOD nor ORGANIZER (RFC 5545 §3.8.4.3 requires ORGANIZER only
  // for group-scheduled components).
  //
  // Omitting is the caller's explicit decision and must not be inferred from
  // `attendees` being empty. Two cases have no attendees and still require an
  // ORGANIZER, and both are silent failures if it goes missing:
  //
  //   - An occurrence override of a series that *does* have attendees. The
  //     spliced object keeps METHOD:REQUEST from the master, and RFC 5546
  //     §3.2.2 requires ORGANIZER in every REQUEST component; Stalwart
  //     rejects the mismatch with 412 SameOrganizerInAllComponents (see
  //     docs/reference/stalwart/observed-behaviour.md).
  //   - Uninviting everyone from an event. Stalwart's scheduler only acts
  //     when the principal is the organizer, so an object naming no organizer
  //     gives the RFC 6638 diff nothing to anchor the CANCEL fan-out on.
  organizer?: string
  // RECURRENCE-ID must use the same timezone/value form as the master's DTSTART,
  // even when the edited occurrence's new start/end use a different timezone —
  // or a different value type: an override of an all-day series carries a DATE
  // RECURRENCE-ID (`recurrenceAllDay`) even when the occurrence becomes timed,
  // and vice versa.
  recurrenceAllDay?: boolean
  // When set, this VEVENT is a single-occurrence override of a recurring
  // series: it carries a RECURRENCE-ID naming the instance it replaces (its
  // *original* start), while start/end are that occurrence's new times.
  // Mutually exclusive with `rrule` — an override is one instance, not a
  // series — so `rrule` is ignored when this is present. See caldav/occurrence.ts.
  recurrenceId?: Date
  recurrenceTimeZone?: string
  // Raw RRULE (no `RRULE:` prefix), e.g. `FREQ=WEEKLY;BYDAY=TH`. Present →
  // the VEVENT becomes a recurring series; start/end are the first
  // occurrence. Omit for a one-off event. See caldav/recurrence.ts.
  rrule?: string
  // RFC 6638 SCHEDULE-AGENT on each ATTENDEE. Default (omitted) leaves the
  // attendees SERVER-scheduled, so Stalwart fans out the iMIP invite/update.
  // 'NONE' stamps SCHEDULE-AGENT=NONE on every ATTENDEE, telling Stalwart to do
  // no scheduling for them — the quiet path for an edit (e.g. dropping one's own
  // duplicate address) that shouldn't re-notify the others. Verified against
  // Stalwart 0.16: NONE suppresses delivery, and a later SERVER edit re-notifies.
  scheduleAgent?: 'NONE' | 'SERVER'
  // iCalendar SEQUENCE. Omit (or 0) for a fresh invite; bump on every edit
  // so attendees' clients treat the re-sent REQUEST as an update, not a
  // duplicate. See update-calendar-event.ts.
  sequence?: number
  // Whether the event counts as busy time, written as TRANSP (RFC 5545
  // §3.8.2.7): `free` is TRANSPARENT, `busy` an explicit OPAQUE. Omit to write
  // no TRANSP line, which reads as busy.
  showAs?: 'busy' | 'free'
  start: Date
  timeZone?: string
  title: string
  // Stable iCalendar UID — a bare UUID (RFC 7986 §5.3: no host or domain
  // data). Independent of the `.ics` resource name the object is stored under
  // (RFC 4791 §5.3.2), so reads match by UID, never by filename (see
  // fetchEvent).
  uid: string
}

// Returns the serialized VCALENDAR string. METHOD:REQUEST + an ORGANIZER
// + ATTENDEE(RSVP) is what triggers Stalwart's server-side scheduling.
// Without attendees there is nothing to schedule — and RFC 5546 requires at
// least one ATTENDEE on a REQUEST — so a personal event is serialized as a
// plain calendar object with no METHOD at all.
export const buildInvite = (input: InviteInput): string => {
  // All-day dates are floating: formatting them in UTC turns the UTC-midnight
  // instants back into exactly the calendar dates they stand for.
  const timeZone = input.allDay ? UTC_TIME_ZONE : (input.timeZone ?? UTC_TIME_ZONE)
  const cal = ical({
    prodId: { company: 'Langmail', product: 'MCP' },
    ...(input.attendees.length > 0 ? { method: ICalCalendarMethod.REQUEST } : {}),
  })
  if (timeZone !== UTC_TIME_ZONE) {
    cal.timezone({ generator: vtimezoneComponent, name: timeZone })
  }

  const event = cal.createEvent({
    end: toZonedDate(input.end, timeZone),
    id: input.uid,
    start: toZonedDate(input.start, timeZone),
    summary: input.title,
    timezone: timeZone,
    ...(input.allDay ? { allDay: true } : {}),
    ...(input.organizer ? { organizer: { email: input.organizer, name: input.organizer } } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    ...(input.showAs ? { transparency: TRANSPARENCY[input.showAs] } : {}),
  })

  // A RECURRENCE-ID makes this the override of one instance; an RRULE would
  // instead (re-)declare a series, so the two never coexist on one VEVENT.
  if (input.recurrenceId) {
    event.recurrenceId(toZonedDate(input.recurrenceId, timeZone))
  } else if (input.rrule) {
    // Passing the raw RRULE string makes this a recurring series; ical-generator
    // emits it as a single `RRULE:` line (adding the prefix itself).
    event.repeating(input.rrule)
  }

  for (const alarm of input.alarms ?? []) {
    if ('minutesBefore' in alarm) {
      event.createAlarm({ description: input.title, trigger: alarm.minutesBefore * 60, type: ICalAlarmType.display })
    }
  }

  for (const attendee of input.attendees) {
    event.createAttendee(attendeeData(attendee))
  }

  return rewriteSerialized(cal.toString(), input, timeZone)
}

// An InviteAttendee as ical-generator attendee data, RSVP always requested.
const attendeeData = (attendee: InviteAttendee): ICalAttendeeData => {
  const { email, name, role, status } = typeof attendee === 'string' ? { email: attendee } : attendee
  return {
    email,
    role: ATTENDEE_ROLES.get(role?.toUpperCase() ?? '') ?? ICalAttendeeRole.REQ,
    rsvp: true,
    status: ATTENDEE_STATUSES.get(status?.toUpperCase() ?? '') ?? ICalAttendeeStatus.NEEDSACTION,
    ...(name ? { name } : {}),
  }
}

// The fixes ical-generator's output needs on the way out, in order. Each one
// rewrites serialized lines because ical-generator offers no lever for it.
const rewriteSerialized = (generated: string, input: InviteInput, timeZone: string): string => {
  // RFC 5545 §3.8.7.2: DTSTAMP is a UTC DATE-TIME — it has no TZID param and no
  // floating form. ical-generator formats it in the event's timezone, so a
  // zoned event gets a floating local timestamp whose meaning depends on the
  // host clock. Restamp it in UTC. (Rewriting the serialized line is the only
  // lever: ical-generator has no per-property timezone.)
  let serialized = generated.replace(DTSTAMP_LINE_RE, `DTSTAMP:${formatUtcTimestamp(new Date())}`)

  // ical-generator formats RECURRENCE-ID like the override's own DTSTART; it
  // must match the *master's* DTSTART instead (zone and value type).
  if (input.recurrenceId) {
    serialized = serialized.replace(
      RECURRENCE_ID_LINE_RE,
      input.recurrenceAllDay
        ? `RECURRENCE-ID;VALUE=DATE:${formatUtcDate(input.recurrenceId)}`
        : formatRecurrenceId(input.recurrenceId, input.recurrenceTimeZone ?? timeZone)
    )
  }

  // Suppress iMIP fan-out by stamping SCHEDULE-AGENT=NONE onto each ATTENDEE
  // (ical-generator has no attendee-param for it). Inserted right after the
  // property name, before ical-generator's own params — order is irrelevant in
  // iCalendar. `^ATTENDEE` (multiline) only matches a line's starting physical
  // line, so a folded continuation is never touched.
  if (input.scheduleAgent === 'NONE') {
    serialized = serialized.replace(ATTENDEE_LINE_START_RE, 'ATTENDEE;SCHEDULE-AGENT=NONE')
  }

  // ical-generator serializes the ATTENDEE CAL-ADDRESS scheme in uppercase
  // (`:MAILTO:`) but the ORGANIZER in lowercase. Stalwart's iMIP scheduler
  // only strips a lowercase `mailto:` to derive the SMTP recipient, so the
  // uppercase scheme leaks into `RCPT TO:<mailto:…>` and the invite bounces.
  // Normalize the value-position scheme to lowercase on every line, folded or
  // not (lowercasing the fold's CRLF + space leaves it intact).
  serialized = serialized.replace(UPPERCASE_MAILTO_RE, (scheme) => scheme.toLowerCase())

  // Stored alarms go in last, after every rewrite above, so they stay exactly
  // as another client wrote them (an EMAIL alarm's ATTENDEE must not pick up
  // SCHEDULE-AGENT, for one).
  const preserved = (input.alarms ?? []).flatMap((alarm) => ('lines' in alarm ? alarm.lines : []))
  if (preserved.length > 0) {
    // A replacer function, not a string: stored text is arbitrary, and a
    // replacement string would expand `$'`, `$&` and `$$` inside it.
    const block = `${preserved.map(foldLine).join(CRLF)}${CRLF}END:VEVENT`
    serialized = serialized.replace(END_VEVENT_RE, () => block)
  }
  return serialized
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

// An instant as an RFC 5545 UTC DATE-TIME value (`YYYYMMDDTHHMMSSZ`).
const formatUtcTimestamp = (instant: Date): string =>
  `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
  `T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`

// An instant's UTC calendar date as an RFC 5545 DATE value (`YYYYMMDD`).
const formatUtcDate = (instant: Date): string =>
  `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}`

const formatRecurrenceId = (instant: Date, timeZone: string): string => {
  if (timeZone === UTC_TIME_ZONE) {
    return `RECURRENCE-ID:${formatUtcTimestamp(instant)}`
  }

  const zoned = toZonedDate(instant, timeZone)
  return (
    `RECURRENCE-ID;TZID=${timeZone}:` +
    `${pad(zoned.getFullYear(), 4)}${pad(zoned.getMonth() + 1)}${pad(zoned.getDate())}` +
    `T${pad(zoned.getHours())}${pad(zoned.getMinutes())}${pad(zoned.getSeconds())}`
  )
}

// Reads the current SEQUENCE off a serialized VEVENT so an edit can bump
// it. A VEVENT without a SEQUENCE line is implicitly 0 (RFC 5545 §3.8.7.4).
const SEQUENCE_RE = /^SEQUENCE:(\d+)/imu

export const parseSequence = (icalString: string): number => {
  const match = SEQUENCE_RE.exec(icalString)
  return match?.[1] ? Number(match[1]) : 0
}

// Highest SEQUENCE across *every* VEVENT in a calendar object. A recurring
// object holds the master plus its per-occurrence overrides, each carrying its
// own SEQUENCE; a fresh (or re-edited) override bumps past this maximum so
// attendees' clients always treat it as the newest revision of that instance.
// No SEQUENCE lines → implicitly 0 (RFC 5545 §3.8.7.4).
const SEQUENCE_ALL_RE = /^SEQUENCE:(\d+)/gimu

export const maxSequence = (icalString: string): number => {
  let max = 0
  for (const match of icalString.matchAll(SEQUENCE_ALL_RE)) {
    const value = Number(match[1])
    if (value > max) {
      max = value
    }
  }
  return max
}
