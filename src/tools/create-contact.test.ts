import { describe, expect, test } from 'bun:test'

import {
  BIRTHDAY_KEY,
  readBirthday,
  readNote,
  readPhones,
  readPostalAddresses,
  readRoles,
  sourceOf,
} from '@langmail/contacts'

import { derivedCard, fakeBook } from './contact-test-fixtures.ts'
import { createContact, createContactInput } from './create-contact.ts'

const args = (over: Record<string, unknown> = {}) => createContactInput.parse({ name: 'Robin Fairweather', ...over })

describe('createContact', () => {
  test('writes a name and a structured postal address with no email at all', async () => {
    const book = fakeBook()
    const result = await createContact(book.deps, {
      args: args({
        postalAddresses: [
          { city: 'München', country: 'DE', label: 'home', postalCode: '80331', street: 'Beispielweg 1' },
        ],
      }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const [card] = [...book.cards.values()]
    expect(card?.name?.full).toBe('Robin Fairweather')
    expect(readPostalAddresses(card as NonNullable<typeof card>)).toEqual([
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
    // Components, not one free-text block — the point of the structured shape.
    expect(result.content[0]?.text).toContain('[a0] Beispielweg 1, 80331 München, DE (home)')
  })

  test('stores the roles the user named as role titles and echoes them back', async () => {
    const book = fakeBook()
    const result = await createContact(book.deps, { args: args({ roles: ['My Lawyer', 'lawyer'] }), token: 'tok' })
    const [card] = [...book.cards.values()]
    expect(card?.titles).toEqual({ r0: { kind: 'role', name: 'lawyer' } })
    expect(readRoles(card as NonNullable<typeof card>)).toEqual(['lawyer'])
    expect(result.content[0]?.text).toContain('roles: lawyer')
  })

  test('stamps the card authored so a later derivation can never relabel it', async () => {
    const book = fakeBook()
    const result = await createContact(book.deps, { args: args(), token: 'tok' })
    const [card] = [...book.cards.values()]
    expect(sourceOf(card as NonNullable<typeof card>, undefined)).toBe('authored')
    expect(result.content[0]?.text).toContain('source: authored')
  })

  test('lands in the default address book so it syncs over CardDAV', async () => {
    const book = fakeBook(
      [],
      [
        { id: 'ab-collected', name: 'Collected' },
        { id: 'ab-personal', isDefault: true, name: 'Personal' },
      ]
    )
    await createContact(book.deps, { args: args(), token: 'tok' })
    const [card] = [...book.cards.values()]
    expect(card?.addressBookIds).toEqual({ 'ab-personal': true })
  })

  test('never lands in the collected book when the server marks no default', async () => {
    // AddressBook/get order says nothing about which book is the user's, so
    // the machine-maintained one is excluded rather than trusted to be last.
    const book = fakeBook(
      [],
      [
        { id: 'ab-collected', name: 'Collected' },
        { id: 'ab-personal', name: 'Personal' },
      ]
    )
    await createContact(book.deps, { args: args(), token: 'tok' })
    const [card] = [...book.cards.values()]
    expect(card?.addressBookIds).toEqual({ 'ab-personal': true })
  })

  test('provisions a personal book when the account has none', async () => {
    const book = fakeBook([], [])
    await createContact(book.deps, { args: args(), token: 'tok' })
    expect(book.books.map((b) => b.name)).toEqual(['Contacts'])
  })

  test('a substring hit on another card is not a duplicate — ownership is exact', async () => {
    // The RFC 9610 `email` filter matches substrings, so a stored
    // joann@example.com answers a query for ann@example.com.
    const book = fakeBook([derivedCard({ emails: { e0: { address: 'joann@example.com' } } })])
    const result = await createContact(book.deps, {
      args: args({ emails: [{ address: 'ann@example.com' }] }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(book.cards.size).toBe(2)
  })

  test('carries phones, organization and note onto the card', async () => {
    const book = fakeBook()
    await createContact(book.deps, {
      args: args({
        emails: [{ address: 'robin@northwind.example', context: 'work' }],
        note: 'Met at the port authority.',
        organization: 'Northwind',
        phones: [{ label: 'mobile', number: '+49 89 1234567' }],
      }),
      token: 'tok',
    })
    const [card] = [...book.cards.values()]
    const stored = card as NonNullable<typeof card>
    expect(readPhones(stored)).toEqual([{ key: 'p0', label: 'mobile', number: '+49 89 1234567' }])
    expect(readNote(stored)).toBe('Met at the port authority.')
    expect(stored.organizations).toEqual({ o0: { name: 'Northwind' } })
    expect(stored.emails?.e0).toEqual({ address: 'robin@northwind.example', contexts: { work: true } })
  })

  test('refuses to split a known person across two cards, and names the one to edit', async () => {
    const book = fakeBook([derivedCard()])
    const result = await createContact(book.deps, {
      args: args({ emails: [{ address: 'Robin@Northwind.example' }] }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('card-robin')
    expect(result.content[0]?.text).toContain('update_contact')
    expect(book.cards.size).toBe(1)
  })

  test('stores a birthday as a JSContact birth anniversary and echoes it back', async () => {
    const book = fakeBook()
    const result = await createContact(book.deps, { args: args({ birthday: '1990-03-03' }), token: 'tok' })
    expect(result.isError).toBeUndefined()
    const [card] = [...book.cards.values()]
    const stored = card as NonNullable<typeof card>
    expect(stored.anniversaries).toEqual({ [BIRTHDAY_KEY]: { date: { day: 3, month: 3, year: 1990 }, kind: 'birth' } })
    expect(readBirthday(stored)).toEqual({ day: 3, month: 3, year: 1990 })
    expect(result.content[0]?.text).toContain('birthday: 1990-03-03')
  })

  test('a birthday without a year stores no year — never a placeholder', async () => {
    const book = fakeBook()
    const result = await createContact(book.deps, { args: args({ birthday: '--02-29' }), token: 'tok' })
    const [card] = [...book.cards.values()]
    expect(readBirthday(card as NonNullable<typeof card>)).toEqual({ day: 29, month: 2 })
    expect(result.content[0]?.text).toContain('birthday: --02-29')
  })

  test('an empty birthday means none, the same idiom update_contact uses to clear', async () => {
    const book = fakeBook()
    const result = await createContact(book.deps, { args: args({ birthday: '' }), token: 'tok' })
    expect(result.isError).toBeUndefined()
    const [card] = [...book.cards.values()]
    expect(card?.anniversaries).toBeUndefined()
  })

  test('a malformed birthday is an error and nothing is created', async () => {
    const book = fakeBook()
    for (const birthday of ['2024-02-30', '3 March 1990']) {
      const result = await createContact(book.deps, { args: args({ birthday }), token: 'tok' })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('Nothing was created')
    }
    expect(book.cards.size).toBe(0)
  })

  test('rejects a postal address with no usable component', () => {
    const parsed = createContactInput.safeParse({ name: 'Robin', postalAddresses: [{ label: 'home' }] })
    expect(parsed.success).toBe(false)
  })

  test('rejects a country that is not an ISO 3166-1 alpha-2 code', () => {
    const parsed = createContactInput.safeParse({
      name: 'Robin',
      postalAddresses: [{ city: 'München', country: 'Germany' }],
    })
    expect(parsed.success).toBe(false)
  })
})
