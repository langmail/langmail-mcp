// Observation extraction: turns the records the writers already hold —
// email detail records in the poller, parsed attendee lists in the calendar
// tools — into graded, content-free observations for the fold. The
// confidence ladder from the design document is applied here, at collection
// time; relationship tiers are read-time (scoring.ts).

import { type EmailAddress } from '../jmap/index.ts'
import { isRelayAddress, normalizeAddress } from './address-class.ts'
import { LARGE_EVENT_ATTENDEES } from './constants.ts'
import { type Confidence, type ExtractedObservations, type Observation, type RelaySighting } from './types.ts'

// The header fields collection reads — a structural subset of
// EmailDetailRecord, so the poller can pass its records straight through.
export interface EmailObservationRecord {
  cc?: EmailAddress[] | null
  from?: EmailAddress[] | null
  id: string
  mailboxIds?: Record<string, boolean> | null
  receivedAt?: string | null
  to?: EmailAddress[] | null
}

export interface EmailObservationOptions {
  // All addresses that are the user themself (lowercased): the @langmail.me
  // address plus any linked Gmail alias — a Gmail-synced user's own alias
  // must never be collected as their most active contact.
  selfAddresses: ReadonlySet<string>
  // Sent-mailbox id, when the caller knows it: membership is the primary
  // direction signal, with the self-address set as fallback.
  sentMailboxId?: string
}

// A display name that is just the address again carries no information.
const cleanName = (name: string | null | undefined, address: string): string | undefined => {
  const trimmed = name?.trim()
  if (!trimmed || normalizeAddress(trimmed) === address) {
    return
  }
  return trimmed
}

const PLUS_TAG_RE = /\+[^@]*@/u

// Self detection tolerates plus-addressed aliases (me+lists@…), so a tagged
// form of the user's own address is never collected as a contact. `address`
// must already be normalized.
const isSelfAddress = (address: string, selfAddresses: ReadonlySet<string>): boolean => {
  if (selfAddresses.has(address)) {
    return true
  }
  const stripped = address.replace(PLUS_TAG_RE, '@')
  return stripped !== address && selfAddresses.has(stripped)
}

interface Collector {
  observations: Observation[]
  relays: RelaySighting[]
  seen: Set<string>
}

const collect = (
  into: Collector,
  entry: { address: string; name?: string | null },
  base: Omit<Observation, 'address' | 'confidence' | 'name'>,
  confidence: Confidence,
  selfAddresses: ReadonlySet<string>
): void => {
  const address = normalizeAddress(entry.address)
  if (!address.includes('@') || into.seen.has(address) || isSelfAddress(address, selfAddresses)) {
    return
  }
  into.seen.add(address)
  if (isRelayAddress(address)) {
    into.relays.push({ address, recordId: base.recordId })
    return
  }
  const name = cleanName(entry.name, address)
  into.observations.push({ address, confidence, ...(name ? { name } : {}), ...base })
}

export const observationsFromEmail = (
  email: EmailObservationRecord,
  opts: EmailObservationOptions
): ExtractedObservations => {
  const date = email.receivedAt
  if (!date) {
    return { observations: [], relays: [] }
  }
  const sentByMailbox = Boolean(opts.sentMailboxId && email.mailboxIds?.[opts.sentMailboxId])
  const sentBySelf = (email.from ?? []).some((a) => isSelfAddress(normalizeAddress(a.email), opts.selfAddresses))
  const outgoing = sentByMailbox || sentBySelf
  const base = {
    channel: 'email',
    date,
    direction: outgoing ? 'outgoing' : 'incoming',
    recordId: email.id,
  } as const
  const into: Collector = { observations: [], relays: [], seen: new Set() }
  const entries = (list: EmailAddress[] | null | undefined) =>
    (list ?? []).map((a) => ({ address: a.email, name: a.name }))
  if (outgoing) {
    // The user authored this mail: To recipients are confirmed pairings,
    // CC recipients were merely copied.
    for (const e of entries(email.to)) {
      collect(into, e, base, 'confirmed', opts.selfAddresses)
    }
    for (const e of entries(email.cc)) {
      collect(into, e, base, 'weak', opts.selfAddresses)
    }
  } else {
    // Received mail: sender and direct recipients are strong; CC is weak.
    for (const e of entries(email.from)) {
      collect(into, e, base, 'strong', opts.selfAddresses)
    }
    for (const e of entries(email.to)) {
      collect(into, e, base, 'strong', opts.selfAddresses)
    }
    for (const e of entries(email.cc)) {
      collect(into, e, base, 'weak', opts.selfAddresses)
    }
  }
  return { observations: into.observations, relays: into.relays }
}

// One ATTENDEE as collection reads it: the bare address, the CN display name
// and the PARTSTAT (ACCEPTED, DECLINED, …) when the line carries them.
export interface EventAttendee {
  email: string
  name?: string
  status?: string
}

// The event fields collection reads — a structural subset of a parsed VEVENT
// (backfill) that the calendar tools can also assemble from their own
// arguments (write-through).
export interface EventObservationRecord {
  attendees: EventAttendee[]
  organizer?: string
  start: string
  uid: string
}

export interface EventObservationOptions {
  // `action`: the user just created/updated/accepted this event via a tool
  // call — every counterpart is a confirmed pairing. `observed`: the event
  // was merely swept up by the backfill; confirmation then requires the
  // user to be the organizer or to have accepted.
  kind: 'action' | 'observed'
  selfAddresses: ReadonlySet<string>
}

const STATUS_ACCEPTED = 'ACCEPTED'

export const observationsFromEvent = (
  event: EventObservationRecord,
  opts: EventObservationOptions
): ExtractedObservations => {
  const selfOrganizer = Boolean(event.organizer && isSelfAddress(normalizeAddress(event.organizer), opts.selfAddresses))
  const selfAccepted = event.attendees.some(
    (a) => isSelfAddress(normalizeAddress(a.email), opts.selfAddresses) && a.status?.toUpperCase() === STATUS_ACCEPTED
  )
  const base: Confidence = opts.kind === 'action' || selfOrganizer || selfAccepted ? 'confirmed' : 'strong'
  // A workshop-sized attendee list is not evidence of a relationship.
  const attendeeConfidence: Confidence = event.attendees.length > LARGE_EVENT_ATTENDEES ? 'weak' : base
  const shared = {
    channel: 'calendar',
    date: event.start,
    direction: selfOrganizer ? 'outgoing' : 'incoming',
    recordId: event.uid,
  } as const
  const into: Collector = { observations: [], relays: [], seen: new Set() }
  // Attendees first: their lines carry the CN display name, and the
  // organizer is almost always also listed as an attendee — collecting the
  // bare organizer first would win the dedup slot and drop the name.
  for (const a of event.attendees) {
    collect(into, { address: a.email, name: a.name }, shared, attendeeConfidence, opts.selfAddresses)
  }
  if (event.organizer) {
    collect(into, { address: event.organizer }, shared, base, opts.selfAddresses)
  }
  return { observations: into.observations, relays: into.relays }
}
