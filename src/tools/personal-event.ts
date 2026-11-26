// At Change, never send (src/access/levels.ts) the event writers touch only
// personal events: ones nobody else is on. An event with any ATTENDEE is a
// meeting the user organizes or an invitation they received, and changing or
// deleting it would notify other people, so the narrowed tools refuse it.

import { needsEverything } from '../access/restrict.ts'
import { type ParsedEvent } from '../ical/index.ts'
import { type ServerMode } from '../mode.ts'

// Set on an event tool's context at Change, never send; `mode` says where the
// user changes the level.
export interface PersonalOnly {
  mode: ServerMode
}

// Every VEVENT in the stored object counts: an override can carry attendees
// the master does not, and an attendee whose address could not be parsed is
// still a person.
export const hasAttendees = (events: ParsedEvent[]): boolean =>
  events.some((event) => event.attendees.length > 0 || (event.unparsedAttendeeCount ?? 0) > 0)

export const meetingRefusal = (uid: string, personalOnly: PersonalOnly): string =>
  needsEverything(
    `Event ${uid} has attendees: it is a meeting with other people or an invitation the user received.`,
    'Meetings with other people',
    personalOnly.mode
  )
