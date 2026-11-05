import { describe, expect, test } from 'bun:test'

import {
  BIRTHDAY_KEY,
  COLLECTED_NOTE_KEY,
  collectedNoteEntry,
  readBirthday,
  readNote,
  readPhones,
  readPostalAddresses,
  sourceOf,
  toCardAddress,
  toCardPhone,
} from '@langmail/contacts'
import { type ContactCard } from '@langmail/jmap'

import { derivedCard, fakeBook } from './contact-test-fixtures.ts'
import { updateContact, updateContactInput } from './update-contact.ts'

const args = (over: Record<string, unknown>) => updateContactInput.parse({ contactId: 'card-robin', ...over })

const authored = (over: Partial<ContactCard> = {}): ContactCard =>
  derivedCard({
    addresses: {
      a0: toCardAddress({
        city: 'München',
        country: 'DE',
        label: 'home',
        postalCode: '80333',
        street: 'Beispielweg 1',
      }),
    },
    phones: { p0: toCardPhone({ label: 'mobile', number: '+49 89 1234567' }) },
    ...over,
  })

const stored = (book: ReturnType<typeof fakeBook>): ContactCard => book.cards.get('card-robin') as ContactCard

describe('updateContact — scalars', () => {
  test('correcting one field leaves every other field stored', async () => {
    const book = fakeBook([authored()])
    const result = await updateContact(book.deps, { args: args({ name: 'Robin Fairweather-Ng' }), token: 'tok' })
    expect(result.isError).toBeUndefined()
    const card = stored(book)
    expect(card.name?.full).toBe('Robin Fairweather-Ng')
    expect(readPhones(card)).toHaveLength(1)
    expect(readPostalAddresses(card)).toHaveLength(1)
    expect(Object.keys(card.emails ?? {})).toEqual(['e0'])
  })

  test('an empty organization clears it, an empty note removes the note entry', async () => {
    const book = fakeBook([authored({ organizations: { o0: { name: 'Northwind' } } })])
    await updateContact(book.deps, { args: args({ note: 'Prefers letters.' }), token: 'tok' })
    expect(readNote(stored(book))).toBe('Prefers letters.')
    await updateContact(book.deps, { args: args({ note: '', organization: '' }), token: 'tok' })
    expect(readNote(stored(book))).toBeUndefined()
    expect(stored(book).organizations).toEqual({})
  })

  test('the note never touches the machine-owned collection payload', async () => {
    const book = fakeBook([authored()])
    await updateContact(book.deps, { args: args({ note: 'Met at the port authority.' }), token: 'tok' })
    // A scoped patch path, not a wholesale `notes` replacement.
    expect(book.patches[0]).toEqual({ 'notes/langmail-note': { note: 'Met at the port authority.' } })
    expect(sourceOf(stored(book), undefined)).toBe('derived')
  })

  test('a card with no notes at all takes a full top-level set (RFC 8620 rejects the scoped path)', async () => {
    const book = fakeBook([{ addressBookIds: { ab: true }, id: 'card-robin', name: { full: 'Robin' } }])
    await updateContact(book.deps, { args: args({ note: 'hello' }), token: 'tok' })
    expect(book.patches[0]).toEqual({ notes: { 'langmail-note': { note: 'hello' } } })
  })
})

describe('updateContact — birthday', () => {
  test('sets a birthday, echoes it, and clears it with ""', async () => {
    const book = fakeBook([authored()])
    const set = await updateContact(book.deps, { args: args({ birthday: '--03-03' }), token: 'tok' })
    expect(set.isError).toBeUndefined()
    expect(set.content[0]?.text).toContain('birthday: --03-03')
    expect(stored(book).anniversaries).toEqual({ [BIRTHDAY_KEY]: { date: { day: 3, month: 3 }, kind: 'birth' } })

    const cleared = await updateContact(book.deps, { args: args({ birthday: '' }), token: 'tok' })
    expect(cleared.isError).toBeUndefined()
    expect(cleared.content[0]?.text).not.toContain('birthday:')
    expect(readBirthday(stored(book))).toBeUndefined()
    // Nothing else was stored, so the property is removed rather than left as `{}`.
    expect(book.patches.at(-1)).toEqual({ anniversaries: null })
    expect(stored(book).anniversaries).toBeUndefined()
  })

  test('a birthday edit keeps a wedding entry a phone wrote and lands on its birth key', async () => {
    const book = fakeBook([
      authored({
        anniversaries: {
          'phone-1': { date: { day: 3, month: 3, year: 1990 }, kind: 'birth' },
          'phone-2': { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' },
        },
      }),
    ])
    await updateContact(book.deps, { args: args({ birthday: '1991-03-04' }), token: 'tok' })
    expect(stored(book).anniversaries).toEqual({
      'phone-1': { date: { day: 4, month: 3, year: 1991 }, kind: 'birth' },
      'phone-2': { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' },
    })
  })

  test('a malformed birthday is an error and nothing is changed', async () => {
    const book = fakeBook([authored()])
    const result = await updateContact(book.deps, { args: args({ birthday: '2024-02-30' }), token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Nothing was changed')
    expect(book.patches).toHaveLength(0)
  })

  test('a birthday alone satisfies the "at least one field" check', () => {
    expect(updateContactInput.safeParse({ birthday: '--03-03', contactId: 'card-robin' }).success).toBe(true)
  })
})

describe('updateContact — deltas', () => {
  test('adds and removes emails without disturbing the ones it was not told about', async () => {
    const book = fakeBook([authored()])
    await updateContact(book.deps, {
      args: args({ addedEmails: [{ address: 'robin.private@gmail.com', context: 'private' }] }),
      token: 'tok',
    })
    expect(Object.values(stored(book).emails ?? {}).map((e) => e.address)).toEqual([
      'robin@northwind.example',
      'robin.private@gmail.com',
    ])
    await updateContact(book.deps, { args: args({ removedEmails: ['Robin@Northwind.example'] }), token: 'tok' })
    expect(Object.values(stored(book).emails ?? {}).map((e) => e.address)).toEqual(['robin.private@gmail.com'])
  })

  test('re-adding an address already on the card is a no-op, not a duplicate', async () => {
    const book = fakeBook([authored()])
    await updateContact(book.deps, {
      args: args({ addedEmails: [{ address: 'robin@northwind.example' }] }),
      token: 'tok',
    })
    expect(Object.keys(stored(book).emails ?? {})).toHaveLength(1)
  })

  test('removes a phone by its handle or by the number itself', async () => {
    const byHandle = fakeBook([authored()])
    await updateContact(byHandle.deps, { args: args({ removedPhones: ['p0'] }), token: 'tok' })
    expect(readPhones(stored(byHandle))).toEqual([])

    const byNumber = fakeBook([authored()])
    await updateContact(byNumber.deps, { args: args({ removedPhones: ['+49 89 1234567'] }), token: 'tok' })
    expect(readPhones(stored(byNumber))).toEqual([])
  })

  test('corrects one component of a stored postal address, keeping the rest', async () => {
    const book = fakeBook([authored()])
    const result = await updateContact(book.deps, {
      args: args({ updatedPostalAddresses: [{ key: 'a0', postalCode: '80331' }] }),
      token: 'tok',
    })
    expect(readPostalAddresses(stored(book))).toEqual([
      {
        city: 'München',
        country: 'DE',
        display: 'Beispielweg 1, 80331 München, DE',
        key: 'a0',
        label: 'home',
        postalCode: '80331',
        street: 'Beispielweg 1',
      },
    ])
    expect(result.content[0]?.text).toContain('[a0] Beispielweg 1, 80331 München, DE (home)')
  })

  test('a correction addressed to an unknown handle fails and lists the stored ones', async () => {
    const book = fakeBook([authored()])
    const result = await updateContact(book.deps, {
      args: args({ updatedPostalAddresses: [{ key: 'a9', postalCode: '80331' }] }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('a9')
    expect(result.content[0]?.text).toContain('Stored handles: a0')
    expect(book.patches).toHaveLength(0)
  })

  test('adds a second postal address under a fresh handle and removes one by label', async () => {
    const book = fakeBook([authored()])
    await updateContact(book.deps, {
      args: args({ addedPostalAddresses: [{ city: 'Wien', country: 'AT', label: 'work', street: 'Musterweg 4' }] }),
      token: 'tok',
    })
    expect(readPostalAddresses(stored(book)).map((a) => a.key)).toEqual(['a0', 'a1'])
    await updateContact(book.deps, { args: args({ removedPostalAddresses: ['home'] }), token: 'tok' })
    expect(readPostalAddresses(stored(book)).map((a) => a.label)).toEqual(['work'])
  })
})

describe('updateContact — guards', () => {
  test('an unknown contact id points at search_contacts', async () => {
    const book = fakeBook([])
    const result = await updateContact(book.deps, {
      args: updateContactInput.parse({ contactId: 'card-nope', name: 'Robin' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('search_contacts')
  })

  test('an update with no field to change is rejected at the schema', () => {
    expect(updateContactInput.safeParse({ contactId: 'card-robin' }).success).toBe(false)
  })
})

describe('updateContact — ownership and preservation', () => {
  test('refuses an address that already belongs to a different contact', async () => {
    const book = fakeBook([
      authored(),
      derivedCard({ emails: { e0: { address: 'other@northwind.example' } }, id: 'card-other' }),
    ])
    const result = await updateContact(book.deps, {
      args: args({ addedEmails: [{ address: 'other@northwind.example' }] }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('card-other')
    expect(book.patches).toHaveLength(0)
  })

  test('a substring hit on another card does not block the add', async () => {
    const book = fakeBook([authored(), derivedCard({ emails: { e0: { address: 'joann@example.com' } }, id: 'card-j' })])
    const result = await updateContact(book.deps, {
      args: args({ addedEmails: [{ address: 'ann@example.com' }] }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(Object.values(stored(book).emails ?? {}).map((e) => e.address)).toContain('ann@example.com')
  })

  test('correcting one component keeps address parts this model has no field for', async () => {
    // A CardDAV-imported address splitting house number from street name,
    // plus a floor: a postal-code fix must not delete either.
    const imported = authored({
      addresses: {
        a0: {
          components: [
            { kind: 'number', value: '54' },
            { kind: 'name', value: 'Winchester Circle' },
            { kind: 'floor', value: '3' },
            { kind: 'postcode', value: '01102' },
            { kind: 'locality', value: 'Springfield' },
          ],
          countryCode: 'US',
        },
      },
    })
    const book = fakeBook([imported])
    await updateContact(book.deps, {
      args: args({ updatedPostalAddresses: [{ key: 'a0', postalCode: '01101' }] }),
      token: 'tok',
    })
    const kinds = (stored(book).addresses?.a0?.components ?? []).map((c) => `${c.kind}=${c.value}`)
    expect(kinds).toContain('number=54')
    expect(kinds).toContain('name=Winchester Circle')
    expect(kinds).toContain('floor=3')
    expect(kinds).toContain('postcode=01101')
    expect(readPostalAddresses(stored(book))[0]?.street).toBe('54 Winchester Circle 3')
  })

  test('replacing the street replaces the whole street line, never half of it', async () => {
    const imported = authored({
      addresses: {
        a0: {
          components: [
            { kind: 'number', value: '54' },
            { kind: 'name', value: 'Winchester Circle' },
          ],
        },
      },
    })
    const book = fakeBook([imported])
    await updateContact(book.deps, {
      args: args({ updatedPostalAddresses: [{ key: 'a0', street: '55 Winchester Circle' }] }),
      token: 'tok',
    })
    expect(readPostalAddresses(stored(book))[0]?.street).toBe('55 Winchester Circle')
  })

  test('a note replaces every user note on the card, not just the reserved one', async () => {
    const twoNotes = authored({
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'imported' }),
        fromClient: { note: 'written in a CardDAV client' },
        fromImport: { note: 'and another one' },
      },
    })
    const book = fakeBook([twoNotes])
    await updateContact(book.deps, { args: args({ note: 'Prefers letters.' }), token: 'tok' })
    expect(readNote(stored(book))).toBe('Prefers letters.')
    // The machine-owned payload is still there.
    expect(sourceOf(stored(book), undefined)).toBe('imported')

    await updateContact(book.deps, { args: args({ note: '' }), token: 'tok' })
    expect(readNote(stored(book))).toBeUndefined()
    expect(sourceOf(stored(book), undefined)).toBe('imported')
  })
})
