import { describe, expect, test } from 'bun:test'

import { type ContactCard } from '@langmail/jmap'

import { collectedNoteEntry, nextKey } from './card.ts'
import { BIRTHDAY_KEY, COLLECTED_NOTE_KEY, USER_NOTE_KEY } from './constants.ts'
import {
  formatBirthday,
  formatCardAddress,
  hasRole,
  isRolePhrase,
  normalizeRole,
  parseBirthday,
  patchCardAddress,
  readBirthday,
  readNote,
  readOrganization,
  readPhones,
  readPostalAddresses,
  readRoles,
  sourceOf,
  toCardAddress,
  toCardPhone,
  userNoteKey,
  withBirthday,
  withRoles,
} from './profile.ts'

const card = (overrides: Partial<ContactCard> = {}): ContactCard => ({
  addressBookIds: { ab1: true },
  id: 'c1',
  ...overrides,
})

describe('postal addresses', () => {
  test('maps a structured address onto RFC 9553 components, countryCode and contexts', () => {
    expect(
      toCardAddress({
        city: 'München',
        country: 'de',
        label: 'home',
        postalCode: '80331',
        street: 'Beispielweg 1',
      })
    ).toEqual({
      components: [
        { kind: 'name', value: 'Beispielweg 1' },
        { kind: 'postcode', value: '80331' },
        { kind: 'locality', value: 'München' },
      ],
      contexts: { private: true },
      countryCode: 'DE',
      full: 'Beispielweg 1, 80331 München, DE',
    })
  })

  test('a label of "other" carries no context, and blank parts are dropped', () => {
    expect(toCardAddress({ city: '  ', label: 'other', street: 'Postfach 12' })).toEqual({
      components: [{ kind: 'name', value: 'Postfach 12' }],
      full: 'Postfach 12',
    })
  })

  test('round-trips through the card shape, keeping the storage key as the handle', () => {
    const stored = readPostalAddresses(
      card({
        addresses: {
          a0: toCardAddress({ city: 'Wien', country: 'AT', label: 'work', postalCode: '1010', street: 'Musterweg 4' }),
        },
      })
    )
    expect(stored).toEqual([
      {
        city: 'Wien',
        country: 'AT',
        display: 'Musterweg 4, 1010 Wien, AT',
        key: 'a0',
        label: 'work',
        postalCode: '1010',
        street: 'Musterweg 4',
      },
    ])
  })

  test('reads a foreign card that carries the country as a component rather than countryCode', () => {
    const stored = readPostalAddresses(
      card({
        addresses: {
          k1: {
            components: [
              { kind: 'name', value: 'Rue Example 9' },
              { kind: 'locality', value: 'Genève' },
              { kind: 'country', value: 'ch' },
            ],
          },
        },
      })
    )
    expect(stored).toEqual([
      {
        city: 'Genève',
        country: 'CH',
        display: 'Rue Example 9, Genève, CH',
        key: 'k1',
        label: 'other',
        street: 'Rue Example 9',
      },
    ])
  })

  test('formats a US-shaped address with its region, house number included', () => {
    expect(
      formatCardAddress({
        components: [
          { kind: 'number', value: '54' },
          { kind: 'name', value: 'Winchester Circle' },
          { kind: 'postcode', value: '01101' },
          { kind: 'locality', value: 'Springfield' },
          { kind: 'region', value: 'MA' },
        ],
        countryCode: 'US',
      })
    ).toBe('54 Winchester Circle, 01101 Springfield, MA, US')
  })

  test('patching keeps components the flat model has no field for', () => {
    const original = {
      components: [
        { kind: 'number', value: '54' },
        { kind: 'name', value: 'Winchester Circle' },
        { kind: 'floor', value: '3' },
        { kind: 'postcode', value: '01102' },
      ],
      contexts: { delivery: true, private: true },
      countryCode: 'US',
    }
    const patched = patchCardAddress(original, { label: 'work', postalCode: '01101' })
    expect(patched.components).toEqual([
      { kind: 'number', value: '54' },
      { kind: 'name', value: 'Winchester Circle' },
      { kind: 'floor', value: '3' },
      { kind: 'postcode', value: '01101' },
    ])
    // `delivery` is not ours to drop; the home/work pair is.
    expect(patched.contexts).toEqual({ delivery: true, work: true })
    expect(patched.full).toBe('54 Winchester Circle 3, 01101, US')
  })
})

describe('phones', () => {
  test('mobile rides on features, work and home on contexts', () => {
    expect(toCardPhone({ label: 'mobile', number: ' +49 89 1234567 ' })).toEqual({
      features: { mobile: true },
      number: '+49 89 1234567',
    })
    expect(toCardPhone({ label: 'work', number: '+49 89 7654321' })).toEqual({
      contexts: { work: true },
      features: { voice: true },
      number: '+49 89 7654321',
    })
    expect(toCardPhone({ label: 'other', number: '+49 89 1' })).toEqual({ number: '+49 89 1' })
  })

  test('round-trips every label through the card shape', () => {
    const phones = {
      p0: toCardPhone({ label: 'mobile', number: '+1' }),
      p1: toCardPhone({ label: 'home', number: '+2' }),
    }
    expect(readPhones(card({ phones }))).toEqual([
      { key: 'p0', label: 'mobile', number: '+1' },
      { key: 'p1', label: 'home', number: '+2' },
    ])
  })
})

describe('birthday', () => {
  test('reads a birth entry with and without a year', () => {
    expect(
      readBirthday(card({ anniversaries: { k0: { date: { day: 3, month: 3, year: 1990 }, kind: 'birth' } } }))
    ).toEqual({ day: 3, month: 3, year: 1990 })
    expect(readBirthday(card({ anniversaries: { k0: { date: { day: 3, month: 3 }, kind: 'birth' } } }))).toEqual({
      day: 3,
      month: 3,
    })
  })

  test('ignores a card with only a wedding entry, and a year-only birthday', () => {
    expect(
      readBirthday(card({ anniversaries: { w: { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' } } }))
    ).toBeUndefined()
    expect(readBirthday(card({ anniversaries: { b: { date: { year: 1990 }, kind: 'birth' } } }))).toBeUndefined()
    expect(readBirthday(card())).toBeUndefined()
  })

  test('treats the vCard 3 sentinel year 1604 as unknown', () => {
    expect(
      readBirthday(card({ anniversaries: { b: { date: { day: 3, month: 3, year: 1604 }, kind: 'birth' } } }))
    ).toEqual({
      day: 3,
      month: 3,
    })
  })

  test('withBirthday keeps a foreign wedding entry and reuses the existing birth key', () => {
    const stored = card({
      anniversaries: {
        'phone-1': { date: { day: 3, month: 3, year: 1990 }, kind: 'birth' },
        'phone-2': { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' },
      },
    })
    expect(withBirthday(stored, { day: 4, month: 3 })).toEqual({
      'phone-1': { date: { day: 4, month: 3 }, kind: 'birth' },
      'phone-2': { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' },
    })
    expect(withBirthday(stored, undefined)).toEqual({
      'phone-2': { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' },
    })
  })

  test('an imported non-date such as Feb 30 is no birthday, not one to clamp', () => {
    expect(readBirthday(card({ anniversaries: { b: { date: { day: 30, month: 2 }, kind: 'birth' } } }))).toBeUndefined()
    expect(
      readBirthday(card({ anniversaries: { b: { date: { day: 29, month: 2, year: 2023 }, kind: 'birth' } } }))
    ).toBeUndefined()
    expect(readBirthday(card({ anniversaries: { b: { date: { day: 29, month: 2 }, kind: 'birth' } } }))).toEqual({
      day: 29,
      month: 2,
    })
  })

  test('a birthday on a non-Gregorian calendar scale is skipped, not misread', () => {
    expect(
      readBirthday(
        card({ anniversaries: { b: { date: { calendarScale: 'hebrew', day: 15, month: 1 }, kind: 'birth' } } })
      )
    ).toBeUndefined()
    expect(
      readBirthday(
        card({ anniversaries: { b: { date: { calendarScale: 'gregorian', day: 3, month: 3 }, kind: 'birth' } } })
      )
    ).toEqual({ day: 3, month: 3 })
  })

  test('withBirthday never overwrites a foreign entry sitting under the reserved key', () => {
    const stored = card({
      anniversaries: { [BIRTHDAY_KEY]: { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' } },
    })
    expect(withBirthday(stored, { day: 3, month: 3 })).toEqual({
      [BIRTHDAY_KEY]: { date: { day: 1, month: 6, year: 2015 }, kind: 'wedding' },
      [`${BIRTHDAY_KEY}-1`]: { date: { day: 3, month: 3 }, kind: 'birth' },
    })
  })

  test('withBirthday takes the reserved key on a card without a birth entry', () => {
    expect(withBirthday(card(), { day: 29, month: 2, year: 2000 })).toEqual({
      [BIRTHDAY_KEY]: { date: { day: 29, month: 2, year: 2000 }, kind: 'birth' },
    })
  })

  test('parseBirthday accepts both spellings and validates the calendar date', () => {
    expect(parseBirthday('1990-03-03')).toEqual({ birthday: { day: 3, month: 3, year: 1990 } })
    expect(parseBirthday(' --03-03 ')).toEqual({ birthday: { day: 3, month: 3 } })
    expect(parseBirthday('--02-29')).toEqual({ birthday: { day: 29, month: 2 } })
    expect(parseBirthday('2000-02-29')).toEqual({ birthday: { day: 29, month: 2, year: 2000 } })
    expect(parseBirthday('2024-02-30')).toHaveProperty('error')
    expect(parseBirthday('2023-02-29')).toHaveProperty('error')
    expect(parseBirthday('--13-01')).toHaveProperty('error')
    expect(parseBirthday('3 March 1990')).toHaveProperty('error')
  })

  test('formatBirthday prints what parseBirthday reads', () => {
    expect(formatBirthday({ day: 3, month: 3, year: 1990 })).toBe('1990-03-03')
    expect(formatBirthday({ day: 3, month: 3 })).toBe('--03-03')
  })
})

describe('roles', () => {
  const jobAndRole = card({
    titles: { r0: { kind: 'role', name: 'Lawyer' }, t0: { kind: 'title', name: 'Partner' } },
  })

  test('normalizes the user phrase: case, spacing and a leading "my"', () => {
    expect(normalizeRole('  My   Divorce Lawyer ')).toBe('divorce lawyer')
    expect(normalizeRole('mystic')).toBe('mystic')
  })

  test('tells a phrase naming a role ("my …") from a plain query', () => {
    expect(isRolePhrase('  My   Lawyer')).toBe(true)
    expect(isRolePhrase('lawyer')).toBe(false)
    expect(isRolePhrase('mystic')).toBe(false)
  })

  test('reads only role-kind titles, never a job title', () => {
    expect(readRoles(jobAndRole)).toEqual(['lawyer'])
    expect(readRoles(card())).toEqual([])
  })

  test('matches a query contained in a role, after normalizing it', () => {
    expect(hasRole(jobAndRole, 'my LAWYER')).toBe(true)
    expect(hasRole(card({ titles: { r0: { kind: 'role', name: 'divorce lawyer' } } }), 'lawyer')).toBe(true)
    expect(hasRole(jobAndRole, 'partner')).toBe(false)
    expect(hasRole(jobAndRole, 'my ')).toBe(false)
    // A name search never lands inside a role word.
    expect(hasRole(card({ titles: { r0: { kind: 'role', name: 'physician' } } }), 'Ian')).toBe(false)
  })

  test('adds without duplicates and removes, leaving job titles in place', () => {
    const titles = withRoles(jobAndRole, ['my landlord', 'lawyer', 'Landlord'], [])
    expect(titles.t0).toEqual({ kind: 'title', name: 'Partner' })
    expect(readRoles({ titles })).toEqual(['lawyer', 'landlord'])
    const removed = withRoles({ titles }, [], ['My Lawyer'])
    expect(readRoles({ titles: removed })).toEqual(['landlord'])
    expect(removed.t0).toEqual({ kind: 'title', name: 'Partner' })
  })

  test('a fresh key never overwrites a stored title', () => {
    const titles = withRoles(card({ titles: { r1: { kind: 'title', name: 'CEO' } } }), ['lawyer'], [])
    expect(Object.keys(titles)).toHaveLength(2)
    expect(titles.r1).toEqual({ kind: 'title', name: 'CEO' })
  })
})

describe('organization and note', () => {
  test('reads the first named organization', () => {
    expect(readOrganization(card({ organizations: { o0: { name: null }, o1: { name: 'Northwind' } } }))).toBe(
      'Northwind'
    )
    expect(readOrganization(card())).toBeUndefined()
  })

  test('reads every note entry except the machine-owned collection payload', () => {
    const notes = {
      [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [] }),
      [USER_NOTE_KEY]: { note: 'Prefers letters.' },
    }
    expect(readNote(card({ notes }))).toBe('Prefers letters.')
  })

  test('a note write targets the card’s single existing user note, else the reserved key', () => {
    expect(userNoteKey(card({ notes: { imported: { note: 'from CardDAV' } } }))).toBe('imported')
    expect(userNoteKey(card({ notes: { a: { note: 'one' }, b: { note: 'two' } } }))).toBe(USER_NOTE_KEY)
    expect(userNoteKey(card())).toBe(USER_NOTE_KEY)
  })
})

describe('sourceOf', () => {
  test('reads the stamped marker', () => {
    const notes = { [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'authored' }) }
    expect(sourceOf(card({ notes }), undefined)).toBe('authored')
  })

  test('an unstamped card came in through an address book we sync', () => {
    expect(sourceOf(card(), undefined)).toBe('imported')
  })

  // Collected cards written before the marker existed carry none.
  test('an unstamped card with a collected uid is derived', () => {
    expect(sourceOf(card({ uid: 'urn:langmail:collected:robin@northwind.example' }), undefined)).toBe('derived')
  })

  test('an unstamped card in the Collected book is derived', () => {
    expect(sourceOf(card({ addressBookIds: { 'book-collected': true } }), 'book-collected')).toBe('derived')
    expect(sourceOf(card({ addressBookIds: { 'book-personal': true } }), 'book-collected')).toBe('imported')
  })

  test('the marker wins over the uid', () => {
    const notes = { [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'authored' }) }
    expect(sourceOf(card({ notes, uid: 'urn:langmail:collected:robin@northwind.example' }), undefined)).toBe('authored')
  })
})

describe('nextKey', () => {
  test('returns the first free slot and never reuses an existing one', () => {
    expect(nextKey({ a0: 1, a1: 1 }, 'a')).toBe('a2')
    expect(nextKey(undefined, 'p')).toBe('p0')
  })
})
