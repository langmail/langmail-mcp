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
  start: Date
  title: string
  // Stable iCalendar UID; also names the `.ics` object on the server.
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
  })

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
