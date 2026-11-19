import { describe, expect, test } from 'bun:test'

import { type ContactCard } from '../jmap/index.ts'
import { collectedNoteEntry, readCollected } from './card.ts'
import { COLLECTED_NOTE_KEY } from './constants.ts'
import { type CardMerge, mergeCards, mergeCollectedExtensions, preferredAddress, withPreferredEmail } from './merge.ts'
import { bestAddress } from './scoring.ts'
import { type CollectedExtension } from './types.ts'

const gymExt: CollectedExtension = {
  addresses: {
    'hello@gym.example': {
      confidence: 'strong',
      count: 4,
      firstSeen: '2026-05-01T08:00:00Z',
      lastSeen: '2026-10-01T08:00:00Z',
    },
  },
  interactions: [{ channel: 'email', date: '2026-10-01T08:00:00Z', direction: 'incoming', recordId: 'm-member' }],
  source: 'derived',
}

const bookingExt: CollectedExtension = {
  addresses: {
    'gym@booking.example': {
      confidence: 'confirmed',
      count: 1,
      firstSeen: '2026-10-29T09:00:00Z',
      lastSeen: '2026-10-29T09:00:00Z',
    },
  },
  interactions: [{ channel: 'email', date: '2026-10-29T09:00:00Z', direction: 'outgoing', recordId: 'm-booking' }],
  relays: ['noreply@booking.example'],
  source: 'derived',
}

const gym = (over: Partial<ContactCard> = {}): ContactCard => ({
  addressBookIds: { collected: true },
  emails: { e0: { address: 'hello@gym.example', contexts: { work: true } } },
  id: 'card-gym',
  name: { full: 'Example Gym' },
  notes: {
    [COLLECTED_NOTE_KEY]: collectedNoteEntry(gymExt),
    'langmail-note': { note: 'Ask for Kim when booking personal training.' },
  },
  ...over,
})

const booking = (over: Partial<ContactCard> = {}): ContactCard => ({
  addressBookIds: { collected: true },
  emails: { e0: { address: 'gym@booking.example', contexts: { work: true } } },
  id: 'card-booking',
  name: { full: 'Example Gym Booking' },
  notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(bookingExt) },
  ...over,
})

const merged = (result: CardMerge | { error: string }): CardMerge => {
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result
}

describe('mergeCollectedExtensions', () => {
  test('sums counts, keeps the extreme dates and the highest grade, unions log and relays', () => {
    const into: CollectedExtension = {
      addresses: {
        'a@example.com': {
          confidence: 'weak',
          count: 2,
          firstSeen: '2026-03-01T00:00:00Z',
          lastSeen: '2026-04-01T00:00:00Z',
        },
      },
      interactions: [{ channel: 'email', date: '2026-04-01T00:00:00Z', direction: 'incoming', recordId: 'r1' }],
      relays: ['relay1@example.com'],
      source: 'authored',
    }
    const from: CollectedExtension = {
      addresses: {
        'a@example.com': {
          confidence: 'strong',
          count: 3,
          firstSeen: '2026-01-01T00:00:00Z',
          lastSeen: '2026-02-01T00:00:00Z',
        },
      },
      interactions: [
        { channel: 'email', date: '2026-04-01T00:00:00Z', direction: 'incoming', recordId: 'r1' },
        { channel: 'calendar', date: '2026-02-01T00:00:00Z', direction: 'outgoing', recordId: 'uid-2' },
      ],
      relays: ['relay2@example.com'],
      source: 'derived',
    }
    const out = mergeCollectedExtensions(into, from, 'card-from')
    expect(out.addresses['a@example.com']).toEqual({
      confidence: 'strong',
      count: 5,
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-04-01T00:00:00Z',
    })
    expect(out.interactions.map((t) => t.recordId)).toEqual(['r1', 'uid-2'])
    expect(out.relays).toEqual(['relay1@example.com', 'relay2@example.com'])
    expect(out.source).toBe('authored')
    expect(out.absorbed).toEqual(['card-from'])
  })

  test('does not sum a card it already absorbed a second time', () => {
    const once = mergeCollectedExtensions(gymExt, bookingExt, 'card-booking')
    expect(mergeCollectedExtensions(once, bookingExt, 'card-booking')).toBe(once)
  })
})

describe('mergeCards', () => {
  test('moves the merged addresses and history onto the kept card', () => {
    const { conflicts, patch } = merged(mergeCards(gym(), [booking()]))
    const emails = patch.emails as Record<string, { address: string }>
    expect(Object.values(emails).map((e) => e.address)).toEqual(['hello@gym.example', 'gym@booking.example'])
    const ext = readCollected({
      ...gym(),
      notes: { [COLLECTED_NOTE_KEY]: patch[`notes/${COLLECTED_NOTE_KEY}`] },
    } as ContactCard)
    expect(Object.keys(ext.addresses)).toEqual(['hello@gym.example', 'gym@booking.example'])
    expect(ext.interactions.map((t) => t.recordId)).toEqual(['m-booking', 'm-member'])
    expect(ext.absorbed).toEqual(['card-booking'])
    expect(ext.relays).toEqual(['noreply@booking.example'])
    // Names differ: the kept one wins, the other is reported.
    expect(conflicts).toEqual([
      'name: kept "Example Gym", dropped "Example Gym Booking" from "Example Gym Booking" (contact_id card-booking)',
    ])
    expect(patch.name).toBeUndefined()
  })

  test('keeps the preferred address although a merged one carries a higher grade', () => {
    const before = bestAddress(gym(), 'any')?.address
    const result = merged(mergeCards(gym(), [booking()]))
    expect(result.preferred).toEqual({ address: 'hello@gym.example', how: 'pinned' })
    expect(result.movedEmails).toEqual(['gym@booking.example'])
    const after = { ...gym(), emails: result.patch.emails } as ContactCard
    expect(bestAddress(after, 'any')?.address).toBe(before)
    expect(preferredAddress(after)).toBe('hello@gym.example')
  })

  test('pins the address the caller names', () => {
    const result = merged(mergeCards(gym(), [booking()], 'Gym@Booking.example'))
    expect(result.preferred).toEqual({ address: 'gym@booking.example', how: 'requested' })
    expect(bestAddress({ ...gym(), emails: result.patch.emails } as ContactCard, 'any')?.address).toBe(
      'gym@booking.example'
    )
  })

  test('refuses a preferred address none of the cards hold', () => {
    expect(mergeCards(gym(), [booking()], 'other@example.com')).toEqual({
      error: 'other@example.com is on none of these contacts. Their addresses: hello@gym.example, gym@booking.example.',
    })
  })

  test('combines notes, joins phones and postal addresses without duplicates', () => {
    const kept = gym({
      addresses: { a0: { components: [{ kind: 'locality', value: 'Musterstadt' }], contexts: { work: true } } },
      phones: { p0: { number: '+49 30 1234567' } },
    })
    const other = booking({
      addresses: {
        a0: { components: [{ kind: 'locality', value: 'Musterstadt' }] },
        a1: { components: [{ kind: 'locality', value: 'Beispielhausen' }] },
      },
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry(bookingExt),
        n0: { note: 'Ask for Kim when booking personal training.' },
        n1: { note: 'Intro appointment booked for November.' },
      },
      phones: { p0: { number: '+49301234567' }, p1: { number: '+49 30 7654321' } },
    })
    const { patch } = merged(mergeCards(kept, [other]))
    expect(Object.values(patch.phones as Record<string, { number: string }>).map((p) => p.number)).toEqual([
      '+49 30 1234567',
      '+49 30 7654321',
    ])
    expect(Object.keys(patch.addresses as Record<string, unknown>)).toEqual(['a0', 'a1'])
    // Only the new note joins, through a patch path beside the kept ones.
    expect(patch['notes/n0']).toEqual({ note: 'Intro appointment booked for November.' })
    expect(patch.notes).toBeUndefined()
  })

  test('a kept card without notes takes a full notes set', () => {
    const { patch } = merged(mergeCards(gym({ notes: null }), [booking()]))
    expect(Object.keys(patch.notes as Record<string, unknown>)).toEqual([COLLECTED_NOTE_KEY])
  })

  test('keeps the kept birthday and reports the other one as a conflict', () => {
    const kept = gym({ anniversaries: { b: { date: { day: 3, month: 3, year: 1990 }, kind: 'birth' } } })
    const other = booking({ anniversaries: { b: { date: { day: 5, month: 4 }, kind: 'birth' } } })
    const { conflicts, patch } = merged(mergeCards(kept, [other]))
    expect(patch.anniversaries).toBeUndefined()
    expect(conflicts).toContain(
      'birthday: kept 1990-03-03, dropped --04-05 from "Example Gym Booking" (contact_id card-booking)'
    )
  })

  test('fills a blank name, organization and birthday from the merged card', () => {
    const kept = gym({ name: null })
    const other = booking({
      anniversaries: { b: { date: { day: 5, month: 4 }, kind: 'birth' } },
      organizations: { o0: { name: 'Example Gym GmbH' } },
    })
    const { conflicts, patch } = merged(mergeCards(kept, [other]))
    expect(patch.name).toEqual({ full: 'Example Gym Booking' })
    expect(patch.organizations).toEqual({ o0: { name: 'Example Gym GmbH' } })
    expect(Object.values(patch.anniversaries as Record<string, { kind: string }>)[0]?.kind).toBe('birth')
    expect(conflicts).toEqual([])
  })

  test('a merged phone keeps no preference of its own, and a filled organization is only the first', () => {
    const other = booking({
      organizations: { o0: { name: 'Example Gym GmbH' }, o1: { name: 'Example Holding' } },
      phones: { p0: { number: '+49 30 7654321', pref: 1 } as never },
    })
    const kept = gym({ phones: { p0: { number: '+49 30 1234567', pref: 1 } as never } })
    const { conflicts, patch } = merged(mergeCards(kept, [other]))
    expect(Object.values(patch.phones as Record<string, { pref?: number }>).map((p) => p.pref)).toEqual([1, undefined])
    expect(patch.organizations).toEqual({ o0: { name: 'Example Gym GmbH' } })
    expect(conflicts.at(-1)).toContain('organizations after the first')
  })

  test('pins the best address even when the merge brings no new address, only history', () => {
    // The kept card holds both addresses; the merged one grades the weaker
    // one higher, which would flip the ranking without the pin.
    const kept = gym({
      emails: { e0: { address: 'hello@gym.example' }, e1: { address: 'gym@booking.example' } },
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry({
          ...gymExt,
          addresses: {
            ...gymExt.addresses,
            'gym@booking.example': {
              confidence: 'weak',
              count: 1,
              firstSeen: '2026-06-01T08:00:00Z',
              lastSeen: '2026-06-01T08:00:00Z',
            },
          },
        }),
      },
    })
    const result = merged(mergeCards(kept, [booking()]))
    expect(result.movedEmails).toEqual([])
    expect(result.preferred).toEqual({ address: 'hello@gym.example', how: 'pinned' })
    const after = {
      ...kept,
      emails: result.patch.emails,
      notes: { [COLLECTED_NOTE_KEY]: result.patch[`notes/${COLLECTED_NOTE_KEY}`] },
    } as ContactCard
    expect(bestAddress(after, 'any')?.address).toBe('hello@gym.example')
  })

  test('postal addresses stored only as full text are told apart by that text', () => {
    const kept = gym({ addresses: { a0: { full: '12 Oak Street, Exampletown' } } })
    const other = booking({
      addresses: { a0: { full: '12 Oak Street, Exampletown' }, a1: { full: '34 Pine Road, Exampletown' } },
    })
    const { patch } = merged(mergeCards(kept, [other]))
    expect(Object.values(patch.addresses as Record<string, { full: string }>).map((a) => a.full)).toEqual([
      '12 Oak Street, Exampletown',
      '34 Pine Road, Exampletown',
    ])
  })

  test('phones that differ only in an extension stay two, and a filled organization is the named one', () => {
    const kept = gym({ phones: { p0: { number: '+49 30 1234567' } } })
    const other = booking({
      organizations: { o0: { name: null }, o1: { name: 'Example Gym GmbH' } },
      phones: { p0: { number: '+49 30 123456 ext. 7' } },
    })
    const { patch } = merged(mergeCards(kept, [other]))
    expect(Object.keys(patch.phones as Record<string, unknown>)).toHaveLength(2)
    expect(patch.organizations).toEqual({ o1: { name: 'Example Gym GmbH' } })
  })

  test('a nested merge carries the absorbed ids along', () => {
    const b = mergeCollectedExtensions(gymExt, bookingExt, 'card-c')
    const a = mergeCollectedExtensions({ addresses: {}, interactions: [] }, b, 'card-b')
    expect(a.absorbed).toEqual(['card-c', 'card-b'])
    expect(mergeCollectedExtensions(a, bookingExt, 'card-c')).toBe(a)
  })

  test('a card already absorbed by another merged card is not summed twice, in either order', () => {
    // C was merged into B before, but its destroy failed.
    const c = booking({ id: 'card-c' })
    const bExt = mergeCollectedExtensions(gymExt, bookingExt, 'card-c')
    const b = gym({ id: 'card-b', notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(bExt) } })
    const kept = gym({ emails: {}, id: 'card-a', notes: null })
    for (const order of [
      [c, b],
      [b, c],
    ]) {
      const { patch } = merged(mergeCards(kept, order))
      const ext = readCollected({
        ...kept,
        notes: patch.notes as ContactCard['notes'],
      })
      expect(ext.addresses['gym@booking.example']?.count).toBe(1)
      expect(ext.absorbed?.sort()).toEqual(['card-b', 'card-c'])
    }
  })

  test('a merged organization card is reported when the kept one is not', () => {
    const other = { ...booking({ name: { full: 'Example Gym' } }), kind: 'org' } as ContactCard
    expect(merged(mergeCards(gym(), [other])).conflicts).toEqual([
      'not carried over from "Example Gym" (contact_id card-booking): kind "org"',
    ])
  })

  test('a filled name keeps its structured parts, and one address gets no preferred mark', () => {
    const name = { components: [{ kind: 'given', value: 'Robin' }], full: 'Robin Example' }
    const kept = gym({ name: null })
    const result = merged(mergeCards(kept, [booking({ emails: {}, name } as Partial<ContactCard>)]))
    expect(result.patch.name).toEqual(name)
    expect(result.preferred).toBeUndefined()
    expect(result.patch.emails).toBeUndefined()
  })

  test('a kept card that already marks its preferred address keeps it unchanged', () => {
    const kept = gym({ emails: { e0: { address: 'hello@gym.example', pref: 1 } } })
    expect(merged(mergeCards(kept, [booking()])).preferred).toEqual({ address: 'hello@gym.example', how: 'unchanged' })
  })

  test('keeps the roles of both cards without duplicates and reports dropped job titles', () => {
    const kept = gym({ titles: { r0: { kind: 'role', name: 'lawyer' } } })
    const other = booking({
      titles: {
        r0: { kind: 'role', name: 'Lawyer' },
        r1: { kind: 'role', name: 'landlord' },
        t0: { kind: 'title', name: 'Partner' },
      },
    })
    const { conflicts, patch } = merged(mergeCards(kept, [other]))
    expect(patch.titles).toEqual({ r0: { kind: 'role', name: 'lawyer' }, r1: { kind: 'role', name: 'landlord' } })
    expect(conflicts).toContain('not carried over from "Example Gym Booking" (contact_id card-booking): job titles')
  })

  test('a job title the kept card already holds is no conflict', () => {
    const kept = gym({ titles: { t0: { kind: 'title', name: 'Partner' } } })
    const { conflicts } = merged(mergeCards(kept, [booking({ titles: { t0: { kind: 'title', name: 'partner' } } })]))
    expect(conflicts.filter((c) => c.includes('job titles'))).toEqual([])
  })

  test('writes no titles when the merged cards bring no new role', () => {
    const kept = gym({ titles: { r0: { kind: 'role', name: 'lawyer' } } })
    const { patch } = merged(mergeCards(kept, [booking({ titles: { r0: { kind: 'role', name: 'my lawyer' } } })]))
    expect(patch.titles).toBeUndefined()
  })

  test('reports properties it does not carry over', () => {
    const other = { ...booking(), nicknames: { k0: { name: 'Gymmy' } } } as ContactCard
    const { conflicts } = merged(mergeCards(gym({ name: { full: 'Example Gym Booking' } }), [other]))
    expect(conflicts).toEqual(['not carried over from "Example Gym Booking" (contact_id card-booking): nicknames'])
  })
})

describe('withPreferredEmail', () => {
  test('marks one address and clears the mark everywhere else', () => {
    const emails = { e0: { address: 'a@example.com', pref: 1 }, e1: { address: 'b@example.com' } }
    expect(withPreferredEmail(emails, 'B@example.com')).toEqual({
      e0: { address: 'a@example.com' },
      e1: { address: 'b@example.com', pref: 1 },
    })
    expect(withPreferredEmail(emails, 'c@example.com')).toBeUndefined()
  })
})
