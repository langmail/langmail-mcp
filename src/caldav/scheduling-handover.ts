// Outbound-scheduling audit trail shared by the calendar write tools.

import { hashEmail, logger } from '@langmail/logger'

// Audit line for the accepted PUT: the iMIP fan-out it triggers is otherwise
// unobservable (Stalwart archives nothing outbound), so record enough to answer
// "was a message due, to whom, at which revision" after the fact. Emitted only
// after the PUT succeeds — a rejected PUT hands nothing to Stalwart and must
// not leave an audit line claiming otherwise. Attendee addresses are logged as
// hashes (REVIEW.md: no email addresses in logs).
export const logSchedulingHandover = (handover: {
  attendees: string[]
  ical: string
  recurrenceId?: string
  removedAttendees: string[]
  // Deliberately non-optional (undefined = SERVER) so call sites pass their
  // possibly-undefined value straight through instead of conditional-spreading.
  scheduleAgent: 'NONE' | undefined
  sequence: number
  uid: string
}): void => {
  logger.info(
    {
      attendeeHashes: handover.attendees.map(hashEmail),
      bytes: Buffer.byteLength(handover.ical),
      removedAttendeeHashes: handover.removedAttendees.map(hashEmail),
      scheduleAgent: handover.scheduleAgent ?? 'SERVER',
      sequence: handover.sequence,
      // Calendar UIDs are commonly email-shaped, so they need the same
      // log-safe deterministic hashing as addresses.
      uidHash: hashEmail(handover.uid),
      ...(handover.recurrenceId ? { recurrenceId: handover.recurrenceId } : {}),
    },
    'event PUT to CalDAV; iMIP fan-out delegated to Stalwart'
  )
}
