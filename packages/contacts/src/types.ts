// Domain types of the collection pipeline. Cards store only content-free
// interaction tuples (date, channel, direction, record id) — never subjects
// or event titles: cards sync to every CardDAV device the user connects,
// where any app holding the contacts permission can read them, and
// mail-derived content must not travel that path. Human-readable interaction
// lines are hydrated from the record ids at query time by search_contacts.

// How reliable the name-to-address pairing is. `confirmed`: the user
// authored mail to the address or scheduled/accepted an event with it.
// `strong`: direct from/to or attendee sighting without a reply. `weak`:
// CC or large-event attendee.
export type Confidence = 'confirmed' | 'strong' | 'weak'

// How much actual interaction exists — computed at read time from the
// stored counters (see scoring.ts), never persisted.
export type Relationship = 'active' | 'incidental' | 'occasional'

export type Channel = 'calendar' | 'email'

export type Direction = 'incoming' | 'outgoing'

export type AddressContext = 'private' | 'work'

// One sighting in a card's bounded interaction log. `recordId` is the JMAP
// Email id for `email`, the iCalendar event UID for `calendar` — the handles
// search_contacts hydrates subjects/titles from, and offers for chaining.
export interface InteractionTuple {
  channel: Channel
  date: string
  direction: Direction
  recordId: string
}

// Per-address collection state inside the extension property.
export interface CollectedAddress {
  confidence: Confidence
  count: number
  firstSeen: string
  lastSeen: string
}

// The langmail.me:collected payload: machine-owned, updated freely.
// `addresses` is keyed by the lowercased address; `interactions` is
// newest-first, capped at INTERACTION_LOG_SIZE; `relays` lists relay
// addresses observed alongside this person (the LinkedIn digest case),
// so output can surface them as excluded rather than silently dropped.
export interface CollectedExtension {
  addresses: Record<string, CollectedAddress>
  interactions: InteractionTuple[]
  relays?: string[]
}

// One sighting of one address in one record, graded at collection time.
// The fold consumes these; extraction (observations.ts) produces them.
export interface Observation {
  address: string
  channel: Channel
  confidence: Confidence
  date: string
  direction: Direction
  name?: string
  recordId: string
}

// A relay address seen in a record — never becomes a card, but is recorded
// on co-occurring people so the output can name it as excluded.
export interface RelaySighting {
  address: string
  recordId: string
}

export interface ExtractedObservations {
  observations: Observation[]
  relays: RelaySighting[]
}
