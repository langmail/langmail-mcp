import { describe, expect, test } from 'bun:test'

import { bestAddress, COLLECTED_NOTE_KEY, collectedNoteEntry, readCollected, readNote } from '@langmail/contacts'
import { type ContactCard } from '@langmail/jmap'

import { derivedCard, fakeBook } from './contact-test-fixtures.ts'
import { mergeContacts, mergeContactsInput } from './merge-contacts.ts'

const hydration = {
  emailGet: () => Promise.resolve([{ id: 'm-booking', subject: 'Your intro appointment' }]),
  fetchEventTitles: () => Promise.resolve(new Map<string, string>()),
  resolveMailAccountId: () => Promise.resolve('mail-acct'),
}

// One organization collected twice: from its own address and from the
// booking platform it uses. Invented names on reserved domains.
const gym = (): ContactCard =>
  derivedCard({
    emails: { e0: { address: 'hello@gym.example', contexts: { work: true } } },
    id: 'card-gym',
    name: { full: 'Example Gym' },
    notes: {
      [COLLECTED_NOTE_KEY]: collectedNoteEntry({
        addresses: {
          'hello@gym.example': {
            confidence: 'strong',
            count: 3,
            firstSeen: '2026-05-01T08:00:00Z',
            lastSeen: '2026-10-01T08:00:00Z',
          },
        },
        interactions: [],
        source: 'derived',
      }),
      'langmail-note': { note: 'Ask for Kim when booking personal training.' },
    },
  })

const booking = (over: Partial<ContactCard> = {}): ContactCard =>
  derivedCard({
    emails: { e0: { address: 'gym@booking.example', contexts: { work: true } } },
    id: 'card-booking',
    name: { full: 'Example Gym Booking' },
    notes: {
      [COLLECTED_NOTE_KEY]: collectedNoteEntry({
        addresses: {
          'gym@booking.example': {
            confidence: 'confirmed',
            count: 1,
            firstSeen: '2026-10-29T09:00:00Z',
            lastSeen: '2026-10-29T09:00:00Z',
          },
        },
        interactions: [
          { channel: 'email', date: '2026-10-29T09:00:00Z', direction: 'outgoing', recordId: 'm-booking' },
        ],
        source: 'derived',
      }),
    },
    ...over,
  })

const run = (book: ReturnType<typeof fakeBook>, over: Record<string, unknown> = {}) =>
  mergeContacts(
    { ...book.deps, ...hydration },
    {
      args: mergeContactsInput.parse({ contactId: 'card-gym', mergeContactIds: ['card-booking'], ...over }),
      token: 'tok',
    }
  )

describe('mergeContacts', () => {
  test('folds the duplicate into the kept card in one write and deletes it', async () => {
    const book = fakeBook([gym(), booking()])
    const merges: unknown[] = []
    const single = book.deps.contactCardMerge
    book.deps = {
      ...book.deps,
      contactCardDestroy: () => Promise.reject(new Error('merge must not destroy in a separate call')),
      contactCardMerge: (p) => {
        merges.push(p)
        return single(p)
      },
      contactCardUpdate: () => Promise.reject(new Error('merge must not update in a separate call')),
    }
    const result = await run(book)
    expect(merges).toHaveLength(1)
    expect(result.isError).toBeUndefined()
    expect(book.cards.has('card-booking')).toBe(false)
    expect(book.patches).toHaveLength(1)
    const kept = book.cards.get('card-gym') as ContactCard
    expect(Object.values(kept.emails ?? {}).map((e) => e.address)).toEqual(['hello@gym.example', 'gym@booking.example'])
    expect(readCollected(kept).interactions.map((t) => t.recordId)).toEqual(['m-booking'])
    expect(readNote(kept)).toBe('Ask for Kim when booking personal training.')
  })

  test('the preferred address stays where it was, and the result says so', async () => {
    const book = fakeBook([gym(), booking()])
    const result = await run(book)
    const kept = book.cards.get('card-gym') as ContactCard
    expect(bestAddress(kept, 'any')?.address).toBe('hello@gym.example')
    expect(result.content[0]?.text).toContain('Preferred address: hello@gym.example, kept from before the merge')
  })

  test('preferredEmail moves the preference to a merged address', async () => {
    const book = fakeBook([gym(), booking()])
    await run(book, { preferredEmail: 'gym@booking.example' })
    expect(bestAddress(book.cards.get('card-gym') as ContactCard, 'any')?.address).toBe('gym@booking.example')
  })

  test('returns the merged card in the detailed format, the conflicts and the removed card', async () => {
    const book = fakeBook([gym(), booking()])
    const text = (await run(book)).content[0]?.text ?? ''
    // Detailed search_contacts lines, interaction subjects hydrated.
    expect(text.startsWith('Merged 1 contact(s) into this one:\n\nExample Gym\n   contact_id: card-gym')).toBe(true)
    expect(text).toContain('   addresses:')
    expect(text).toContain('hello@gym.example (work, strong, preferred')
    expect(text).toContain('email sent: Your intro appointment')
    expect(text).toContain('name: kept "Example Gym", dropped "Example Gym Booking"')
    // Enough of the removed card to recreate it by hand.
    expect(text).toContain('Removed contacts:\n\nExample Gym Booking\n   contact_id: card-booking')
    expect(text).toContain('   - gym@booking.example')
    expect(text).toContain('Moved addresses: gym@booking.example.')
    expect(text).toContain('create_contact')
  })

  test('a second birthday is kept off the card and listed as a conflict', async () => {
    const kept = { ...gym(), anniversaries: { b: { date: { day: 3, month: 3 }, kind: 'birth' } } }
    const book = fakeBook([kept, booking({ anniversaries: { b: { date: { day: 4, month: 4 }, kind: 'birth' } } })])
    const text = (await run(book)).content[0]?.text ?? ''
    expect(text).toContain('birthday: kept --03-03, dropped --04-04')
    expect((book.cards.get('card-gym') as ContactCard).anniversaries).toEqual(kept.anniversaries)
  })

  test('merging a card into itself changes nothing', async () => {
    const book = fakeBook([gym(), booking()])
    const result = await run(book, { mergeContactIds: ['card-gym'] })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Nothing was changed')
    expect(book.patches).toEqual([])
  })

  test('an unknown id changes nothing and names the id', async () => {
    const book = fakeBook([gym(), booking()])
    const result = await run(book, { mergeContactIds: ['card-booking', 'card-ghost'] })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('No contact with id card-ghost. Nothing was changed.')
    expect(book.cards.has('card-booking')).toBe(true)
  })

  test('a preferredEmail none of the cards hold changes nothing', async () => {
    const book = fakeBook([gym(), booking()])
    const result = await run(book, { preferredEmail: 'someone@example.org' })
    expect(result.isError).toBe(true)
    expect(book.cards.has('card-booking')).toBe(true)
    expect(book.patches).toEqual([])
  })

  test('a refused destroy is reported with how to finish', async () => {
    const book = fakeBook([gym(), booking()])
    const deps = {
      ...book.deps,
      ...hydration,
      contactCardMerge: async (p: Parameters<typeof book.deps.contactCardMerge>[0]) => {
        await book.deps.contactCardMerge({ ...p, destroy: [] })
        return { destroyed: [], notDestroyed: { 'card-booking': 'forbidden' } }
      },
    }
    const result = await mergeContacts(deps, {
      args: mergeContactsInput.parse({ contactId: 'card-gym', mergeContactIds: ['card-booking'] }),
      token: 'tok',
    })
    const text = result.content[0]?.text ?? ''
    expect(text.startsWith('Merged 1 contact(s) (0 deleted) into this one:')).toBe(true)
    expect(text).toContain('Not deleted: card-booking (its address book is read-only)')
    expect(text).toContain('mergeContactIds: ["card-booking"] only')
    // The update landed; the card that still exists is not listed for recreation.
    expect(Object.keys(book.cards.get('card-gym')?.emails ?? {})).toHaveLength(2)
    expect(text).not.toContain('Removed contacts:')
  })

  test('a failed read-back still returns the recovery details', async () => {
    const book = fakeBook([gym(), booking()])
    const deps = {
      ...book.deps,
      ...hydration,
      contactCardGet: (p: Parameters<typeof book.deps.contactCardGet>[0]) =>
        book.cards.has('card-booking') ? book.deps.contactCardGet(p) : Promise.reject(new Error('timeout')),
    }
    const result = await mergeContacts(deps, {
      args: mergeContactsInput.parse({ contactId: 'card-gym', mergeContactIds: ['card-booking'] }),
      token: 'tok',
    })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('into contact card-gym; reading it back failed')
    expect(text).toContain('Removed contacts:\n\nExample Gym Booking')
  })

  test('a refused update with nothing deleted says nothing changed', async () => {
    const book = fakeBook([gym(), booking()])
    const deps = {
      ...book.deps,
      ...hydration,
      contactCardMerge: () => Promise.resolve({ destroyed: [], notDestroyed: {}, updateError: 'forbidden' }),
    }
    const result = await mergeContacts(deps, {
      args: mergeContactsInput.parse({ contactId: 'card-gym', mergeContactIds: ['card-booking'] }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      'Could not update the contact to keep: its address book is read-only. Nothing was changed.'
    )
  })

  test('a refused update whose destroys landed hands back the deleted cards', async () => {
    const book = fakeBook([gym(), booking()])
    const deps = {
      ...book.deps,
      ...hydration,
      contactCardMerge: () =>
        Promise.resolve({ destroyed: ['card-booking'], notDestroyed: {}, updateError: 'invalidProperties' }),
    }
    const result = await mergeContacts(deps, {
      args: mergeContactsInput.parse({ contactId: 'card-gym', mergeContactIds: ['card-booking'] }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('but the server deleted card-booking')
    expect(text).toContain('Example Gym Booking\n   contact_id: card-booking')
    expect(text).toContain('   - gym@booking.example')
  })
})
