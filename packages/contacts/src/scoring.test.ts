import { describe, expect, test } from 'bun:test'

import { type ContactCard } from '@langmail/jmap'

import { collectedNoteEntry } from './card.ts'
import { COLLECTED_NOTE_KEY } from './constants.ts'
import { bestAddress, rankCards, relationshipFor, relativeAge } from './scoring.ts'
import { type CollectedAddress, type CollectedExtension } from './types.ts'

const NOW = new Date('2026-07-24T12:00:00Z')

const entry = (over: Partial<CollectedAddress> = {}): CollectedAddress => ({
  confidence: 'strong',
  count: 1,
  firstSeen: '2026-07-01T09:00:00Z',
  lastSeen: '2026-07-20T09:00:00Z',
  ...over,
})

const ext = (addresses: Record<string, CollectedAddress>): CollectedExtension => ({
  addresses,
  interactions: [],
})

describe('relationshipFor', () => {
  test('active needs enough interactions and a recent one', () => {
    expect(relationshipFor(ext({ a: entry({ count: 3 }) }), NOW)).toBe('active')
  })

  test('many interactions long ago are occasional, not active', () => {
    expect(relationshipFor(ext({ a: entry({ count: 9, lastSeen: '2025-01-01T00:00:00Z' }) }), NOW)).toBe('occasional')
  })

  test('a single sighting is incidental; two are occasional', () => {
    expect(relationshipFor(ext({ a: entry({ count: 1 }) }), NOW)).toBe('incidental')
    expect(relationshipFor(ext({ a: entry({ count: 2 }) }), NOW)).toBe('occasional')
  })

  test('counts sum across a person’s addresses', () => {
    expect(relationshipFor(ext({ a: entry({ count: 2 }), b: entry({ count: 1 }) }), NOW)).toBe('active')
  })
})

const card = (id: string, addresses: Record<string, CollectedAddress>, emails?: ContactCard['emails']): ContactCard =>
  ({
    addressBookIds: { b: true },
    emails: emails ?? Object.fromEntries(Object.keys(addresses).map((a, i) => [`e${i}`, { address: a }])),
    id,
    notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(ext(addresses)) },
  }) as ContactCard

describe('rankCards', () => {
  test('ranks by tier, then by last interaction', () => {
    const activeOld = card('active-old', { 'a@x.example': entry({ count: 5, lastSeen: '2026-07-01T00:00:00Z' }) })
    const activeNew = card('active-new', { 'b@x.example': entry({ count: 3, lastSeen: '2026-07-23T00:00:00Z' }) })
    const incidental = card('incidental', { 'c@x.example': entry({ count: 1 }) })
    const occasional = card('occasional', { 'd@x.example': entry({ count: 2 }) })
    const ranked = rankCards([incidental, activeOld, occasional, activeNew], NOW)
    expect(ranked.map((c) => c.id)).toEqual(['active-new', 'active-old', 'occasional', 'incidental'])
  })
})

describe('bestAddress', () => {
  const robin = card(
    'robin',
    {
      'robin.private@gmail.com': entry({ confidence: 'weak', lastSeen: '2026-07-22T00:00:00Z' }),
      'robin@northwind.example': entry({ confidence: 'confirmed', lastSeen: '2026-07-20T00:00:00Z' }),
    },
    {
      e0: { address: 'robin@northwind.example', contexts: { work: true } },
      e1: { address: 'robin.private@gmail.com', contexts: { private: true } },
    }
  )

  test('picks by confidence under context any', () => {
    expect(bestAddress(robin, 'any')?.address).toBe('robin@northwind.example')
  })

  test('a private bias prefers the private address without filtering the person', () => {
    const best = bestAddress(robin, 'private')
    expect(best?.address).toBe('robin.private@gmail.com')
    expect(best?.confidence).toBe('weak')
  })

  test('a work bias keeps the work address on top', () => {
    expect(bestAddress(robin, 'work')?.address).toBe('robin@northwind.example')
  })

  test('an address the user added by hand counts as confirmed', () => {
    const manual = card('manual', {}, { e0: { address: 'hand@entered.example' } })
    expect(bestAddress(manual, 'any')).toEqual({
      address: 'hand@entered.example',
      confidence: 'confirmed',
      context: 'work',
    })
  })
})

describe('relativeAge', () => {
  test('mirrors the design examples', () => {
    expect(relativeAge('2026-07-24T09:00:00Z', NOW)).toBe('today')
    expect(relativeAge('2026-07-23T09:00:00Z', NOW)).toBe('yesterday')
    expect(relativeAge('2026-07-20T12:00:00Z', NOW)).toBe('4 days ago')
    expect(relativeAge('2026-06-30T12:00:00Z', NOW)).toBe('24 days ago')
    expect(relativeAge('2026-06-05T12:00:00Z', NOW)).toBe('7 weeks ago')
    expect(relativeAge('2026-03-24T12:00:00Z', NOW)).toBe('4 months ago')
    expect(relativeAge('2024-07-24T12:00:00Z', NOW)).toBe('2 years ago')
  })

  test('handles upcoming events naturally', () => {
    expect(relativeAge('2026-07-25T12:00:00Z', NOW)).toBe('tomorrow')
    expect(relativeAge('2026-07-28T12:00:00Z', NOW)).toBe('in 4 days')
  })

  test('degrades an unparseable date instead of throwing', () => {
    expect(relativeAge('not-a-date', NOW)).toBe('unknown date')
  })
})
