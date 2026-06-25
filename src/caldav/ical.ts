// Builds the iMIP invitation (VCALENDAR/VEVENT, METHOD:REQUEST) that we
// PUT to the principal's CalDAV calendar. `ical-generator` owns escaping,
// CRLF line-folding, and date formatting; this module just maps our
// invite shape onto it.

import ical, { ICalAttendeeRole, ICalAttendeeStatus, ICalCalendarMethod } from 'ical-generator'

export interface InviteInput {
  attendees: string[]
  description?: string
  end: Date
  location?: string
  // Bare organizer email (no `mailto:`), the authenticated principal.
  organizer: string
  // Raw RRULE (no `RRULE:` prefix), e.g. `FREQ=WEEKLY;BYDAY=TH`. Present →
  // the VEVENT becomes a recurring series; start/end are the first
  // occurrence. Omit for a one-off event. See caldav/recurrence.ts.
  rrule?: string
  // iCalendar SEQUENCE. Omit (or 0) for a fresh invite; bump on every edit
  // so attendees' clients treat the re-sent REQUEST as an update, not a
  // duplicate. See update-calendar-event.ts.
  sequence?: number
  start: Date
  title: string
  // Stable iCalendar UID. Our create tool also uses it to name the `.ics`
  // resource on PUT, but the server is authoritative — other clients may
  // name the object differently, so reads match by UID (see fetchEvent).
  uid: string
}

// Returns the serialized VCALENDAR string. METHOD:REQUEST + an ORGANIZER
// + ATTENDEE(RSVP) is what triggers Stalwart's server-side scheduling.
export const buildInvite = (input: InviteInput): string => {
  const cal = ical({
    method: ICalCalendarMethod.REQUEST,
    prodId: { company: 'Langmail', product: 'MCP' },
  })

  const event = cal.createEvent({
    end: input.end,
    id: input.uid,
    organizer: { email: input.organizer, name: input.organizer },
    start: input.start,
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  })

  // Passing the raw RRULE string makes this a recurring series; ical-generator
  // emits it as a single `RRULE:` line (adding the prefix itself).
  if (input.rrule) {
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

  // ical-generator serializes the ATTENDEE CAL-ADDRESS scheme in uppercase
  // (`:MAILTO:`) but the ORGANIZER in lowercase. Stalwart's iMIP scheduler
  // only strips a lowercase `mailto:` to derive the SMTP recipient, so the
  // uppercase scheme leaks into `RCPT TO:<mailto:…>` and the invite bounces.
  // Normalize the value-position scheme to lowercase on every line.
  return cal.toString().replaceAll(':MAILTO:', ':mailto:')
}

// Reads the current SEQUENCE off a serialized VEVENT so an edit can bump
// it. A VEVENT without a SEQUENCE line is implicitly 0 (RFC 5545 §3.8.7.4).
const SEQUENCE_RE = /^SEQUENCE:(\d+)/mu

export const parseSequence = (ical: string): number => {
  const match = SEQUENCE_RE.exec(ical)
  return match?.[1] ? Number(match[1]) : 0
}
