// Contact write-through for the calendar tools: after a successful
// create/update/RSVP, the attendee list the tool already holds is folded
// into the user's collected address book under the request's own bearer.
// This covers the organizer side that mail headers never see — the
// motivating Robin case enters the address book the moment the lunch is
// scheduled. Failures are logged, never surfaced: a contact upsert must
// not fail a scheduling action.

import { collectContacts, liveCollectionDeps, observationsFromEvent } from '../contacts/index.ts'
import { type ParsedAttendee } from '../ical/index.ts'
import { accountIdForContacts, bearerAuthorization, type JmapLive } from '../jmap/index.ts'
import { logger } from '../logger/index.ts'

export interface AttendeeWriteThroughInput {
  attendees: ParsedAttendee[]
  // `action` (default): the user scheduled or accepted this event, so every
  // counterpart is a confirmed pairing. `observed`: the user merely
  // interacted with someone else's event without accepting it (a decline or
  // a tentative RSVP) — the design ladder reserves `confirmed` for an
  // accepted invitation, so those grade one step lower.
  kind?: 'action' | 'observed'
  // The event's ORGANIZER (may be a counterpart, e.g. when RSVPing).
  organizer?: string
  // The authenticated principal's own calendar-user-address — excluded from
  // collection so the user never becomes their own contact. Accepted delta
  // from the plan's full self-address set: linked Gmail aliases live in
  // Postgres, and this service is deliberately database-free, so an event
  // listing the user's own Gmail alias as an attendee collects that alias.
  // The email-agent's fold (which does know the aliases) never counts it.
  selfAddress: string
  start: string
  token: string
  uid: string
}

export type AttendeeWriteThrough = (input: AttendeeWriteThroughInput) => Promise<void>

export const makeAttendeeWriteThrough =
  (live: JmapLive): AttendeeWriteThrough =>
  async (input) => {
    try {
      const authorization = bearerAuthorization(input.token)
      const session = await live.getSession(authorization)
      const ctx = { accountId: accountIdForContacts(session), apiUrl: session.apiUrl, authorization }
      const extracted = observationsFromEvent(
        {
          attendees: input.attendees,
          start: input.start,
          uid: input.uid,
          ...(input.organizer ? { organizer: input.organizer } : {}),
        },
        { kind: input.kind ?? 'action', selfAddresses: new Set([input.selfAddress.trim().toLowerCase()]) }
      )
      await collectContacts(liveCollectionDeps, ctx, extracted)
    } catch (err) {
      logger.warn({ err }, 'Contact write-through failed after a calendar action')
    }
  }
