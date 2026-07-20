// Builds the iMIP invitation (VCALENDAR/VEVENT, METHOD:REQUEST) that we
// PUT to the principal's CalDAV calendar. `ical-generator` owns escaping,
// CRLF line-folding, and date formatting; this module just maps our
// invite shape onto it.

import { getVtimezoneComponent } from '@touch4it/ical-timezones'
import ical, { ICalAttendeeRole, ICalAttendeeStatus, ICalCalendarMethod } from 'ical-generator'

import { toZonedDate, UTC_TIME_ZONE } from './timezone.ts'

const RECURRENCE_ID_LINE_RE = /^RECURRENCE-ID(?:;[^:]*)?:.*$/mu

export interface InviteInput {
  attendees: string[]
  description?: string
  end: Date
  location?: string
  // Bare organizer email (no `mailto:`), the authenticated principal.
  organizer: string
  // When set, this VEVENT is a single-occurrence override of a recurring
  // series: it carries a RECURRENCE-ID naming the instance it replaces (its
  // *original* start), while start/end are that occurrence's new times.
  // Mutually exclusive with `rrule` — an override is one instance, not a
  // series — so `rrule` is ignored when this is present. See caldav/occurrence.ts.
  recurrenceId?: Date
  // RECURRENCE-ID must use the same timezone/value form as the master's DTSTART,
  // even when the edited occurrence's new start/end use a different timezone.
  recurrenceTimeZone?: string
  // Raw RRULE (no `RRULE:` prefix), e.g. `FREQ=WEEKLY;BYDAY=TH`. Present →
  // the VEVENT becomes a recurring series; start/end are the first
  // occurrence. Omit for a one-off event. See caldav/recurrence.ts.
  rrule?: string
  // iCalendar SEQUENCE. Omit (or 0) for a fresh invite; bump on every edit
  // so attendees' clients treat the re-sent REQUEST as an update, not a
  // duplicate. See update-calendar-event.ts.
  sequence?: number
  start: Date
  timeZone?: string
  title: string
  // Stable iCalendar UID. Our create tool also uses it to name the `.ics`
  // resource on PUT, but the server is authoritative — other clients may
  // name the object differently, so reads match by UID (see fetchEvent).
  uid: string
}

// Returns the serialized VCALENDAR string. METHOD:REQUEST + an ORGANIZER
// + ATTENDEE(RSVP) is what triggers Stalwart's server-side scheduling.
export const buildInvite = (input: InviteInput): string => {
  const timeZone = input.timeZone ?? UTC_TIME_ZONE
  const cal = ical({
    method: ICalCalendarMethod.REQUEST,
    prodId: { company: 'Langmail', product: 'MCP' },
  })
  if (timeZone !== UTC_TIME_ZONE) {
    cal.timezone({ generator: getVtimezoneComponent, name: timeZone })
  }

  const event = cal.createEvent({
    end: toZonedDate(input.end, timeZone),
    id: input.uid,
    organizer: { email: input.organizer, name: input.organizer },
    start: toZonedDate(input.start, timeZone),
    summary: input.title,
    timezone: timeZone,
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
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

  for (const email of input.attendees) {
    event.createAttendee({
      email,
      role: ICalAttendeeRole.REQ,
      rsvp: true,
      status: ICalAttendeeStatus.NEEDSACTION,
    })
  }

  let serialized = cal.toString()
  if (input.recurrenceId && input.recurrenceTimeZone && input.recurrenceTimeZone !== timeZone) {
    serialized = serialized.replace(
      RECURRENCE_ID_LINE_RE,
      formatRecurrenceId(input.recurrenceId, input.recurrenceTimeZone)
    )
  }

  // ical-generator serializes the ATTENDEE CAL-ADDRESS scheme in uppercase
  // (`:MAILTO:`) but the ORGANIZER in lowercase. Stalwart's iMIP scheduler
  // only strips a lowercase `mailto:` to derive the SMTP recipient, so the
  // uppercase scheme leaks into `RCPT TO:<mailto:…>` and the invite bounces.
  // Normalize the value-position scheme to lowercase on every line.
  return serialized.replaceAll(':MAILTO:', ':mailto:')
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

const formatRecurrenceId = (instant: Date, timeZone: string): string => {
  if (timeZone === UTC_TIME_ZONE) {
    return (
      'RECURRENCE-ID:' +
      `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
      `T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
    )
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
const SEQUENCE_RE = /^SEQUENCE:(\d+)/mu

export const parseSequence = (icalString: string): number => {
  const match = SEQUENCE_RE.exec(icalString)
  return match?.[1] ? Number(match[1]) : 0
}

// Highest SEQUENCE across *every* VEVENT in a calendar object. A recurring
// object holds the master plus its per-occurrence overrides, each carrying its
// own SEQUENCE; a fresh (or re-edited) override bumps past this maximum so
// attendees' clients always treat it as the newest revision of that instance.
// No SEQUENCE lines → implicitly 0 (RFC 5545 §3.8.7.4).
const SEQUENCE_ALL_RE = /^SEQUENCE:(\d+)/gmu

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
