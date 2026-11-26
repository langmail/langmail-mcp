// At Change, never send (src/access/levels.ts) the event writers touch only
// personal events: ones nobody else is on. An event with anyone else on it is
// a meeting the user organizes or an invitation they received, and changing or
// deleting it would notify those people, so the narrowed tools refuse it.

import { type Narrowed, needsEverything } from '../access/narrowed.ts'
import { type ParsedEvent } from '../ical/index.ts'

const isSelf = (email: string, selfAddress: string): boolean => email.toLowerCase() === selfAddress.toLowerCase()

// Every VEVENT in the stored object counts: an override can carry attendees the
// master does not. An attendee whose address could not be parsed is someone
// else. The user's own address as the only attendee (some clients write the
// organizer as an attendee) leaves the event personal, unless someone else
// organizes it: then it is an invitation the user received. An alias of the
// account counts as someone else, which refuses rather than reaches.
export const hasOtherPeople = (events: ParsedEvent[], selfAddress: string): boolean =>
  events.some(
    (event) =>
      (event.unparsedAttendeeCount ?? 0) > 0 ||
      event.attendees.some((attendee) => !isSelf(attendee.email, selfAddress)) ||
      (event.attendees.length > 0 && event.organizer !== undefined && !isSelf(event.organizer, selfAddress))
  )

export const meetingRefusal = (uid: string, narrowed: Narrowed): string =>
  needsEverything(
    `Event ${uid} has attendees: it is a meeting with other people or an invitation the user received.`,
    'Meetings with other people',
    narrowed.mode
  )
