import { describe, expect, test } from 'bun:test'

import { type ContactCard, type ContactCardEmail } from '../jmap/index.ts'
import {
  cardAddresses,
  collectedNoteEntry,
  collectedUid,
  nextEmailKey,
  nextKey,
  normalizeName,
  readCollected,
} from './card.ts'
import { COLLECTED_NOTE_KEY, COLLECTED_NOTE_TEXT, COLLECTED_PROPERTY } from './constants.ts'
import { type CollectedExtension } from './types.ts'

const card = (over: Partial<ContactCard> = {}): ContactCard => ({
  addressBookIds: { 'book-collected': true },
  emails: { e0: { address: 'robin@northwind.example', contexts: { work: true } } },
  id: 'card-1',
  name: { full: 'Robin Fairweather' },
  ...over,
})

// A card whose machine-owned note entry carries an arbitrary payload — the
// shapes a CardDAV client can leave behind are not typeable, so tests reach
// past the type to place them.
const cardCarrying = (payload: unknown): ContactCard =>
  card({
    notes: { [COLLECTED_NOTE_KEY]: { note: COLLECTED_NOTE_TEXT, [COLLECTED_PROPERTY]: payload } },
  } as Partial<ContactCard>)

const ext = (over: Partial<CollectedExtension> = {}): CollectedExtension => ({
  addresses: {
    'robin@northwind.example': {
      confidence: 'strong',
      count: 1,
      firstSeen: '2026-07-20T12:00:00Z',
      lastSeen: '2026-07-20T12:00:00Z',
    },
  },
  interactions: [{ channel: 'email', date: '2026-07-20T12:00:00Z', direction: 'incoming', recordId: 'm1' }],
  ...over,
})

describe('collectedNoteEntry', () => {
  test('wraps the payload under the vendor property alongside the human-readable note', () => {
    const payload = ext()
    expect(collectedNoteEntry(payload)).toEqual({
      [COLLECTED_PROPERTY]: payload,
      note: COLLECTED_NOTE_TEXT,
    })
  })

  test('holds the payload by reference rather than cloning it', () => {
    const payload = ext()
    expect(collectedNoteEntry(payload)[COLLECTED_PROPERTY]).toBe(payload)
  })
})

describe('readCollected — round trip', () => {
  test('reads back what collectedNoteEntry wrote', () => {
    const payload = ext({ relays: ['noreply@northwind.example'], source: 'derived' })
    expect(readCollected(cardCarrying(payload))).toEqual(payload)
  })
})

describe('readCollected — degrades to empty, never throws', () => {
  test('a card with no notes at all', () => {
    expect(readCollected(card())).toEqual({ addresses: {}, interactions: [] })
  })

  test('a card whose notes lack the machine-owned entry', () => {
    const userNoted = card({ notes: { 'langmail-note': { note: 'lunch partner' } } })
    expect(readCollected(userNoted)).toEqual({ addresses: {}, interactions: [] })
  })

  test('the entry present but the vendor property dropped', () => {
    const stripped = card({ notes: { [COLLECTED_NOTE_KEY]: { note: COLLECTED_NOTE_TEXT } } })
    expect(readCollected(stripped)).toEqual({ addresses: {}, interactions: [] })
  })

  test('the payload mangled into a primitive', () => {
    for (const mangled of ['', 'a string', 0, 42, true, null]) {
      expect(readCollected(cardCarrying(mangled))).toEqual({ addresses: {}, interactions: [] })
    }
  })

  test('an array payload passes the object check and yields the empty extension', () => {
    expect(readCollected(cardCarrying([1, 2, 3]))).toEqual({ addresses: {}, interactions: [] })
  })
})

describe('readCollected — per-field defensiveness', () => {
  test('a non-object `addresses` degrades to empty', () => {
    for (const mangled of ['nonsense', 7, true, null, undefined]) {
      expect(readCollected(cardCarrying({ addresses: mangled })).addresses).toEqual({})
    }
  })

  test('a non-array `interactions` degrades to empty', () => {
    for (const mangled of ['nonsense', 7, true, null, undefined, {}]) {
      expect(readCollected(cardCarrying({ interactions: mangled })).interactions).toEqual([])
    }
  })

  // An array is `typeof 'object'`, so it survives the check that rejects the
  // other mangled shapes — today's behaviour, quirk included.
  test('an array `addresses` survives as-is', () => {
    expect(readCollected(cardCarrying({ addresses: [] })).addresses).toEqual([] as never)
  })

  // The guard is a shape check only: entries are never validated field by
  // field, so junk inside a well-shaped container is passed straight through.
  test('entries inside a well-shaped container are not validated', () => {
    const junk = readCollected(
      cardCarrying({ addresses: { 'not an address': 'not a record' }, interactions: ['junk'] })
    )
    expect(junk.addresses).toEqual({ 'not an address': 'not a record' } as never)
    expect(junk.interactions).toEqual(['junk'] as never)
  })
})

describe('readCollected — optional keys are omitted rather than nulled', () => {
  test('a non-empty `relays` is kept', () => {
    const relays = ['noreply@northwind.example', 'bounces@northwind.example']
    expect(readCollected(cardCarrying({ relays })).relays).toEqual(relays)
  })

  test('an empty `relays` is dropped entirely', () => {
    const read = readCollected(cardCarrying({ relays: [] }))
    expect(read.relays).toBeUndefined()
    expect('relays' in read).toBe(false)
  })

  test('a non-array `relays` is dropped entirely', () => {
    for (const mangled of ['noreply@northwind.example', 7, true, null, {}]) {
      expect('relays' in readCollected(cardCarrying({ relays: mangled }))).toBe(false)
    }
  })

  test('each known `source` is round-tripped', () => {
    for (const source of ['authored', 'derived', 'imported'] as const) {
      expect(readCollected(cardCarrying({ source })).source).toBe(source)
    }
  })

  test('an unknown or mangled `source` is dropped entirely', () => {
    for (const mangled of ['collected', 'DERIVED', '', 7, true, null, {}]) {
      expect('source' in readCollected(cardCarrying({ source: mangled }))).toBe(false)
    }
  })
})

describe('cardAddresses', () => {
  test('normalizes every address on the card', () => {
    const messy = card({
      emails: {
        e0: { address: '  Robin@NorthWind.example ' },
        e1: { address: 'ROBIN.WORK@northwind.example' },
      },
    })
    expect(cardAddresses(messy)).toEqual(['robin@northwind.example', 'robin.work@northwind.example'])
  })

  test('a card with no emails yields no addresses', () => {
    expect(cardAddresses(card({ emails: undefined }))).toEqual([])
    expect(cardAddresses(card({ emails: null }))).toEqual([])
    expect(cardAddresses(card({ emails: {} }))).toEqual([])
  })

  // Keys are the card's own scheme, so insertion order — not key order — is
  // what the reader sees, and duplicates are not collapsed.
  test('preserves insertion order and keeps duplicates', () => {
    const dupes = card({
      emails: {
        e1: { address: 'robin@northwind.example' },
        e0: { address: 'Robin@northwind.example' },
      },
    })
    expect(cardAddresses(dupes)).toEqual(['robin@northwind.example', 'robin@northwind.example'])
  })
})

describe('normalizeName', () => {
  test('trims, collapses inner whitespace, and lowercases', () => {
    expect(normalizeName('  Robin   Fairweather  ')).toBe('robin fairweather')
    expect(normalizeName('Robin\tFairweather')).toBe('robin fairweather')
    expect(normalizeName('Robin\n Fairweather')).toBe('robin fairweather')
  })

  test('an already normalized name is unchanged', () => {
    expect(normalizeName('robin fairweather')).toBe('robin fairweather')
  })

  test('a blank name normalizes to the empty string', () => {
    expect(normalizeName('   ')).toBe('')
  })

  // The merge gate is exact-match on this output: casing and spacing are the
  // only differences it forgives. Everything else is a distinct person.
  test('does not fold accents, punctuation, or name order', () => {
    expect(normalizeName('Renée Fairweather')).not.toBe(normalizeName('Renee Fairweather'))
    expect(normalizeName('Fairweather, Robin')).not.toBe(normalizeName('Robin Fairweather'))
    expect(normalizeName('R. Fairweather')).not.toBe(normalizeName('Robin Fairweather'))
  })
})

describe('nextKey', () => {
  test('starts at zero when there is nothing to avoid', () => {
    expect(nextKey({}, 'e')).toBe('e0')
    expect(nextKey(null, 'e')).toBe('e0')
    expect(nextKey(undefined, 'e')).toBe('e0')
  })

  test('skips past a contiguous run', () => {
    expect(nextKey({ e0: 1, e1: 2, e2: 3 }, 'e')).toBe('e3')
  })

  // First *free* slot, not highest + 1: a deleted middle key is reused.
  test('fills a gap rather than appending past the highest key', () => {
    expect(nextKey({ e0: 1, e2: 3 }, 'e')).toBe('e1')
  })

  test('only keys sharing the prefix are avoided', () => {
    expect(nextKey({ e0: 1, p0: 2 }, 'p')).toBe('p1')
    expect(nextKey({ a0: 1, b0: 2 }, 'e')).toBe('e0')
  })

  test('a key whose value is undefined still counts as taken', () => {
    expect(nextKey({ e0: undefined }, 'e')).toBe('e1')
  })
})

describe('nextEmailKey', () => {
  test('is nextKey bound to the card email prefix', () => {
    const emails: Record<string, ContactCardEmail> = {
      e0: { address: 'robin@northwind.example' },
      e1: { address: 'robin.work@northwind.example' },
    }
    expect(nextEmailKey(emails)).toBe('e2')
    expect(nextEmailKey({})).toBe('e0')
  })
})

describe('collectedUid', () => {
  test('derives a stable urn from the normalized address', () => {
    expect(collectedUid('robin@northwind.example')).toBe('urn:langmail:collected:robin@northwind.example')
  })

  test('addresses differing only in case or padding share one uid', () => {
    expect(collectedUid('  Robin@NorthWind.example ')).toBe(collectedUid('robin@northwind.example'))
  })

  test('distinct addresses get distinct uids', () => {
    expect(collectedUid('robin@northwind.example')).not.toBe(collectedUid('robin.work@northwind.example'))
  })
})
