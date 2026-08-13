import { describe, expect, test } from 'bun:test'

import { type ContactCard } from '@langmail/jmap'

import { collectedNoteEntry } from './card.ts'
import { COLLECTED_NOTE_KEY, COLLECTED_PATCH_PATH, COLLECTED_PROPERTY, INTERACTION_LOG_SIZE } from './constants.ts'
import { foldObservations } from './fold.ts'
import { type CollectedExtension, type Observation } from './types.ts'

const BOOK = 'book-collected'

const obs = (over: Partial<Observation> = {}): Observation => ({
  address: 'robin@northwind.example',
  channel: 'email',
  confidence: 'strong',
  date: '2026-07-20T12:00:00Z',
  direction: 'incoming',
  name: 'Robin Fairweather',
  recordId: 'm1',
  ...over,
})

// Extension payload off either a create draft (nested in the machine note
// entry) or an update patch (scoped patch path).
const readExt = (holder: Record<string, unknown>): CollectedExtension => {
  const entry =
    (holder[COLLECTED_PATCH_PATH] as Record<string, unknown> | undefined) ??
    (holder.notes as Record<string, Record<string, unknown>> | undefined)?.[COLLECTED_NOTE_KEY]
  return entry?.[COLLECTED_PROPERTY] as CollectedExtension
}

const existingCard = (over: Partial<ContactCard> = {}): ContactCard => ({
  addressBookIds: { 'book-personal': true },
  emails: { e0: { address: 'robin@northwind.example', contexts: { work: true } } },
  id: 'card-1',
  name: { full: 'Robin Fairweather' },
  ...over,
})

describe('foldObservations — creation', () => {
  test('a new person becomes one card in the collected book with graded extension data', () => {
    const { creates, updates } = foldObservations({ cards: [], collectedBookId: BOOK }, [obs()])
    expect(updates).toEqual([])
    expect(creates).toHaveLength(1)
    const card = creates[0]
    expect(card?.addressBookIds).toEqual({ [BOOK]: true })
    expect(card?.name).toEqual({ full: 'Robin Fairweather' })
    expect(card?.version).toBe('1.0')
    expect(card?.uid).toBe('urn:langmail:collected:robin@northwind.example')
    expect(Object.values(card?.emails ?? {})).toEqual([
      { address: 'robin@northwind.example', contexts: { work: true } },
    ])
    const ext = readExt(card as unknown as Record<string, unknown>)
    expect(ext.addresses['robin@northwind.example']).toEqual({
      confidence: 'strong',
      count: 1,
      firstSeen: '2026-07-20T12:00:00Z',
      lastSeen: '2026-07-20T12:00:00Z',
    })
    expect(ext.interactions).toEqual([
      { channel: 'email', date: '2026-07-20T12:00:00Z', direction: 'incoming', recordId: 'm1' },
    ])
  })

  test('the Robin case: a created lunch event yields a confirmed work address', () => {
    const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, [
      obs({
        channel: 'calendar',
        confidence: 'confirmed',
        date: '2026-07-28T12:00:00Z',
        direction: 'outgoing',
        recordId: 'evt-lunch@langmail.me',
      }),
    ])
    const ext = readExt(creates[0] as unknown as Record<string, unknown>)
    expect(ext.addresses['robin@northwind.example']?.confidence).toBe('confirmed')
    expect(Object.values(creates[0]?.emails ?? {})[0]?.contexts).toEqual({ work: true })
  })

  test('two same-first-name people without co-occurrence stay unmerged', () => {
    const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, [
      obs({ address: 'robin@northwind.example', name: 'Robin', recordId: 'm1' }),
      obs({ address: 'robin@othercorp.example', name: 'Robin', recordId: 'm2' }),
    ])
    expect(creates).toHaveLength(2)
  })

  test('an exact-name match with co-occurrence joins the address to the existing person', () => {
    const { creates, updates } = foldObservations({ cards: [existingCard()], collectedBookId: BOOK }, [
      obs({ address: 'robin@northwind.example', recordId: 'm9' }),
      obs({ address: 'robin.private@gmail.com', name: 'robin  fairweather', recordId: 'm9' }),
    ])
    expect(creates).toEqual([])
    expect(updates).toHaveLength(1)
    const patch = updates[0]?.patch ?? {}
    const emails = Object.values((patch.emails ?? {}) as Record<string, { address: string }>)
    expect(emails.map((e) => e.address).sort()).toEqual(['robin.private@gmail.com', 'robin@northwind.example'])
    const ext = readExt(patch)
    expect(ext.addresses['robin.private@gmail.com']?.confidence).toBe('strong')
  })

  test('a name match without co-occurrence does NOT join — separate card instead', () => {
    const { creates, updates } = foldObservations({ cards: [existingCard()], collectedBookId: BOOK }, [
      obs({ address: 'robin.private@gmail.com', name: 'Robin Fairweather', recordId: 'm-other' }),
    ])
    expect(updates).toEqual([])
    expect(creates).toHaveLength(1)
  })
})

describe('foldObservations — updates and ownership', () => {
  test('sent-mail confirmation upgrades a strong address, never downgrades a confirmed one', () => {
    const card = existingCard({
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry({
          addresses: {
            'robin@northwind.example': {
              confidence: 'strong',
              count: 2,
              firstSeen: '2026-05-01T09:00:00Z',
              lastSeen: '2026-06-01T09:00:00Z',
            },
          },
          interactions: [],
        }),
      },
    })
    const upgraded = foldObservations({ cards: [card], collectedBookId: BOOK }, [
      obs({ confidence: 'confirmed', date: '2026-07-01T09:00:00Z', direction: 'outgoing', recordId: 'm-sent' }),
    ])
    const ext = readExt(upgraded.updates[0]?.patch ?? {})
    expect(ext.addresses['robin@northwind.example']?.confidence).toBe('confirmed')
    expect(ext.addresses['robin@northwind.example']?.count).toBe(3)
    expect(ext.addresses['robin@northwind.example']?.lastSeen).toBe('2026-07-01T09:00:00Z')

    const downgraded = foldObservations(
      { cards: [{ ...card, notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(ext) } }], collectedBookId: BOOK },
      [obs({ confidence: 'weak', recordId: 'm-cc' })]
    )
    const ext2 = readExt(downgraded.updates[0]?.patch ?? {})
    expect(ext2.addresses['robin@northwind.example']?.confidence).toBe('confirmed')
  })

  test('re-folding a record already in the interaction log does not double-count', () => {
    const first = foldObservations({ cards: [existingCard()], collectedBookId: BOOK }, [obs()])
    const patch = first.updates[0]?.patch ?? {}
    const afterFirst = {
      ...existingCard(),
      notes: patch.notes ?? { [COLLECTED_NOTE_KEY]: patch[COLLECTED_PATCH_PATH] },
      ...(patch.emails ? { emails: patch.emails } : {}),
    } as ContactCard
    const second = foldObservations({ cards: [afterFirst], collectedBookId: BOOK }, [obs()])
    // The observation is absorbed without a counter or log change.
    if (second.updates.length > 0) {
      const ext = readExt(second.updates[0]?.patch ?? {})
      expect(ext.addresses['robin@northwind.example']?.count).toBe(1)
      expect(ext.interactions).toHaveLength(1)
    }
    expect(second.creates).toEqual([])
  })

  test('a personal-book card gains extension data in place — no duplicate in the collected book', () => {
    const { creates, updates } = foldObservations({ cards: [existingCard()], collectedBookId: BOOK }, [obs()])
    expect(creates).toEqual([])
    expect(updates).toHaveLength(1)
    expect(updates[0]?.cardId).toBe('card-1')
    // addressBookIds untouched: the card stays in the personal book.
    expect(updates[0]?.patch.addressBookIds).toBeUndefined()
  })

  test('a card without notes gets a full top-level notes set (RFC 8620 rejects the scoped path)', () => {
    const { updates } = foldObservations({ cards: [existingCard()], collectedBookId: BOOK }, [obs()])
    const patch = updates[0]?.patch ?? {}
    expect(patch[COLLECTED_PATCH_PATH]).toBeUndefined()
    expect((patch.notes as Record<string, unknown>)[COLLECTED_NOTE_KEY]).toBeDefined()
  })

  test('a card with user notes gets the scoped path so those notes survive', () => {
    const withUserNote = existingCard({
      notes: { mine: { note: 'met at the conference' } },
    } as Partial<ContactCard>)
    const { updates } = foldObservations({ cards: [withUserNote], collectedBookId: BOOK }, [obs()])
    const patch = updates[0]?.patch ?? {}
    expect(patch.notes).toBeUndefined()
    expect(patch[COLLECTED_PATCH_PATH]).toBeDefined()
  })

  test('fills a blank display name but never overwrites a user-set one', () => {
    const nameless = existingCard({ name: undefined })
    const filled = foldObservations({ cards: [nameless], collectedBookId: BOOK }, [obs()])
    expect(filled.updates[0]?.patch.name).toEqual({ full: 'Robin Fairweather' })

    const named = existingCard({ name: { full: 'Robin M. (edited)' } })
    const kept = foldObservations({ cards: [named], collectedBookId: BOOK }, [obs()])
    expect(kept.updates[0]?.patch.name).toBeUndefined()
  })

  test('caps the interaction log and keeps it newest-first', () => {
    const observations = Array.from({ length: INTERACTION_LOG_SIZE + 3 }, (_, i) =>
      obs({ date: `2026-07-${String(i + 1).padStart(2, '0')}T09:00:00Z`, recordId: `m${i}` })
    )
    const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, observations)
    const ext = readExt(creates[0] as unknown as Record<string, unknown>)
    expect(ext.interactions).toHaveLength(INTERACTION_LOG_SIZE)
    expect(ext.interactions[0]?.recordId).toBe(`m${INTERACTION_LOG_SIZE + 2}`)
    expect(ext.addresses['robin@northwind.example']?.count).toBe(INTERACTION_LOG_SIZE + 3)
    expect(ext.addresses['robin@northwind.example']?.firstSeen).toBe('2026-07-01T09:00:00Z')
  })

  test('records a relay observed alongside a known person on that person', () => {
    const { updates } = foldObservations(
      { cards: [existingCard()], collectedBookId: BOOK },
      [obs({ recordId: 'm-digest' })],
      [{ address: 'messaging-digest-noreply@linkedin.com', recordId: 'm-digest' }]
    )
    const ext = readExt(updates[0]?.patch ?? {})
    expect(ext.relays).toEqual(['messaging-digest-noreply@linkedin.com'])
  })

  test('a relay with no co-occurring person touches nothing', () => {
    const { creates, updates } = foldObservations(
      { cards: [existingCard()], collectedBookId: BOOK },
      [],
      [{ address: 'messaging-digest-noreply@linkedin.com', recordId: 'm-solo' }]
    )
    expect(creates).toEqual([])
    expect(updates).toEqual([])
  })
})

describe('foldObservations — provenance', () => {
  test('a card the fold creates is stamped derived', () => {
    const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, [obs()])
    expect(readExt(creates[0] as unknown as Record<string, unknown>).source).toBe('derived')
  })

  test('an authored stamp survives later collection — derivation never relabels the card', () => {
    const card = existingCard({
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'authored' }),
      },
    })
    const { updates } = foldObservations({ cards: [card], collectedBookId: BOOK }, [obs()])
    expect(readExt(updates[0]?.patch ?? {}).source).toBe('authored')
  })

  test('an authored name is never overwritten by an observed one', () => {
    const card = existingCard({ name: { full: 'Robin Fairweather-Ng' } })
    const { updates } = foldObservations({ cards: [card], collectedBookId: BOOK }, [obs({ name: 'Robin Fairweather' })])
    expect(updates[0]?.patch.name).toBeUndefined()
  })
})
