// Mapping between the collection domain and the JSContact card shape —
// reading the extension property defensively (cards are user-editable in
// any CardDAV client) and small helpers the fold shares with the reader.

import { type ContactCard, type ContactCardEmail, type ContactCardNote } from '@langmail/jmap'

import { normalizeAddress } from './address-class.ts'
import { COLLECTED_NOTE_KEY, COLLECTED_NOTE_TEXT, COLLECTED_PROPERTY } from './constants.ts'
import { type CollectedExtension } from './types.ts'

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
    addresses: typeof ext.addresses === 'object' && ext.addresses ? ext.addresses : {},
    interactions: Array.isArray(ext.interactions) ? ext.interactions : [],
    ...(Array.isArray(ext.relays) && ext.relays.length > 0 ? { relays: ext.relays } : {}),
  }
}

export const cardAddresses = (card: ContactCard): string[] =>
  Object.values(card.emails ?? {}).map((e) => normalizeAddress(e.address))

// Exact normalized display-name match is the merge gate: lowercased,
// whitespace collapsed. Nothing fuzzier — a wrong merge silently corrupts a
// user-visible address book, a missed merge merely shows two candidates.
export const normalizeName = (name: string): string => name.trim().replace(/\s+/gu, ' ').toLowerCase()

// First free e<n> key: existing cards keep their key scheme, we only ever add.
export const nextEmailKey = (emails: Record<string, ContactCardEmail>): string => {
  let n = 0
  while (`e${n}` in emails) {
    n += 1
  }
  return `e${n}`
}

// Deterministic uid so a crashed-and-retried create of the same person
// resolves to the same identity instead of minting a new one.
export const collectedUid = (address: string): string => `urn:langmail:collected:${normalizeAddress(address)}`
