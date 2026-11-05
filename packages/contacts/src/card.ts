// Mapping between the collection domain and the JSContact card shape —
// reading the extension property defensively (cards are user-editable in
// any CardDAV client) and small helpers the fold shares with the reader.

import { type ContactCard, type ContactCardEmail, type ContactCardNote } from '@langmail/jmap'

import { normalizeAddress } from './address-class.ts'
import { COLLECTED_NOTE_KEY, COLLECTED_NOTE_TEXT, COLLECTED_PROPERTY } from './constants.ts'
import { type CollectedExtension, type ContactSource } from './types.ts'

const SOURCES = new Set<ContactSource>(['authored', 'derived', 'imported'])

const emptyExtension = (): CollectedExtension => ({ addresses: {}, interactions: [] })

// The machine-owned note entry carrying the collection payload — Stalwart
// round-trips vendor properties inside entry objects but not at the Card's
// top level (see constants.ts).
export const collectedNoteEntry = (ext: CollectedExtension): ContactCardNote => ({
  [COLLECTED_PROPERTY]: ext,
  note: COLLECTED_NOTE_TEXT,
})

// Defensive read: a CardDAV client may have mangled or dropped parts of the
// machine-owned entry; missing pieces degrade to empty, never throw.
export const readCollected = (card: ContactCard): CollectedExtension => {
  const raw = card.notes?.[COLLECTED_NOTE_KEY]?.[COLLECTED_PROPERTY]
  if (!raw || typeof raw !== 'object') {
    return emptyExtension()
  }
  const ext = raw as Partial<CollectedExtension>
  return {
    ...(Array.isArray(ext.absorbed) && ext.absorbed.length > 0 ? { absorbed: ext.absorbed } : {}),
    addresses: typeof ext.addresses === 'object' && ext.addresses ? ext.addresses : {},
    interactions: Array.isArray(ext.interactions) ? ext.interactions : [],
    ...(Array.isArray(ext.relays) && ext.relays.length > 0 ? { relays: ext.relays } : {}),
    // Round-tripped rather than re-derived: every fold rebuilds the entry
    // from what it read here, so the marker survives later collection.
    ...(ext.source && SOURCES.has(ext.source) ? { source: ext.source } : {}),
  }
}

export const cardAddresses = (card: ContactCard): string[] =>
  Object.values(card.emails ?? {}).map((e) => normalizeAddress(e.address))

// Exact normalized display-name match is the merge gate: lowercased,
// whitespace collapsed. Nothing fuzzier — a wrong merge silently corrupts a
// user-visible address book, a missed merge merely shows two candidates.
export const normalizeName = (name: string): string => name.trim().replace(/\s+/gu, ' ').toLowerCase()

// First free `<prefix><n>` key: existing cards keep their key scheme, we only
// ever add — so a handle printed in one response stays valid in the next.
export const nextKey = (existing: Record<string, unknown> | null | undefined, prefix: string): string => {
  let n = 0
  while (`${prefix}${n}` in (existing ?? {})) {
    n += 1
  }
  return `${prefix}${n}`
}

export const nextEmailKey = (emails: Record<string, ContactCardEmail>): string => nextKey(emails, 'e')

// Deterministic uid so a crashed-and-retried create of the same person
// resolves to the same identity instead of minting a new one.
export const COLLECTED_UID_PREFIX = 'urn:langmail:collected:'

export const collectedUid = (address: string): string => `${COLLECTED_UID_PREFIX}${normalizeAddress(address)}`
