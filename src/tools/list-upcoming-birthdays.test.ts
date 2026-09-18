import { describe, expect, test } from 'bun:test'

import { type ContactCard, type ContactCardAnniversary } from '@langmail/jmap'

import { derivedCard } from './contact-test-fixtures.ts'
import {
  CARD_CAP,
  type ListUpcomingBirthdaysDeps,
  listUpcomingBirthdays,
  listUpcomingBirthdaysInput,
} from './list-upcoming-birthdays.ts'

const birth = (date: ContactCardAnniversary['date']): Record<string, ContactCardAnniversary> => ({
  b: { date, kind: 'birth' },
})

const person = (id: string, name: string, anniversaries?: Record<string, ContactCardAnniversary>): ContactCard =>
  derivedCard({
    ...(anniversaries ? { anniversaries } : {}),
    emails: { e0: { address: `${id}@northwind.example` } },
    id,
    name: { full: name },
  })

const makeDeps = (cards: ContactCard[], timeZone: string | null = null): ListUpcomingBirthdaysDeps => ({
  contactCardGet: (p) => Promise.resolve(cards.filter((c) => p.ids.includes(c.id))),
  contactCardQuery: (p) => Promise.resolve(cards.map((c) => c.id).slice(0, p.limit)),
  resolveAccountId: () => Promise.resolve('acct'),
  resolveTimeZone: () => Promise.resolve(timeZone),
})

const args = (over: Record<string, unknown> = {}) => listUpcomingBirthdaysInput.parse({ from: '2026-09-18', ...over })

describe('listUpcomingBirthdays', () => {
  test('lists the window sorted by date, with days until, the age turned, and the best address', async () => {
    const cards = [
      person('card-late', 'Late Person', birth({ day: 30, month: 10 })),
      person('card-robin', 'Robin Fairweather', birth({ day: 2, month: 10, year: 1990 })),
      person('card-today', 'Today Person', birth({ day: 18, month: 9 })),
      person('card-none', 'No Birthday'),
      person('card-wedding', 'Only Wedding', { w: { date: { day: 20, month: 9, year: 2015 }, kind: 'wedding' } }),
    ]
    const result = await listUpcomingBirthdays(makeDeps(cards), { args: args({ days: 30 }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(text).toContain('2 upcoming birthday(s) in the next 30 day(s) from 2026-09-18')
    expect(text).toContain('1. Today Person — 2026-09-18 (today)')
    expect(text).toContain('2. Robin Fairweather — 2026-10-02 (in 14 days, turning 36)')
    expect(text).toContain('   contact_id: card-robin')
    expect(text).toContain('   birthday: 1990-10-02')
    expect(text).toContain('   best_address: card-robin@northwind.example')
    // Outside the window, no birthday, and a wedding are all left out.
    expect(text).not.toContain('Late Person')
    expect(text).not.toContain('No Birthday')
    expect(text).not.toContain('Only Wedding')
  })

  test('the window end is exclusive and same-day birthdays sort by name', async () => {
    const cards = [
      person('card-b', 'Beta Person', birth({ day: 25, month: 9 })),
      person('card-a', 'Alpha Person', birth({ day: 25, month: 9 })),
      person('card-edge', 'Edge Person', birth({ day: 25, month: 9 })),
    ]
    const inside = await listUpcomingBirthdays(makeDeps(cards), { args: args({ days: 8 }), token: 'tok' })
    const text = inside.content[0]?.text ?? ''
    expect(text.indexOf('Alpha Person')).toBeLessThan(text.indexOf('Beta Person'))
    expect(text.indexOf('Beta Person')).toBeLessThan(text.indexOf('Edge Person'))

    const outside = await listUpcomingBirthdays(makeDeps(cards), { args: args({ days: 7 }), token: 'tok' })
    expect(outside.content[0]?.text).toContain('No birthdays in the next 7 day(s) from 2026-09-18')
  })

  test('a birthday early next year is found across the year boundary', async () => {
    const cards = [person('card-jan', 'January Person', birth({ day: 2, month: 1, year: 2000 }))]
    const result = await listUpcomingBirthdays(makeDeps(cards), {
      args: args({ days: 14, from: '2026-12-28' }),
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('January Person — 2027-01-02 (in 5 days, turning 27)')
  })

  test('Feb 29 lands on Feb 28 in a non-leap year', async () => {
    const cards = [person('card-leap', 'Leap Person', birth({ day: 29, month: 2, year: 2000 }))]
    const result = await listUpcomingBirthdays(makeDeps(cards), {
      args: args({ days: 7, from: '2027-02-25' }),
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('Leap Person — 2027-02-28 (in 3 days, turning 27)')
  })

  test('a window before a known birth year lists nothing, the birth date itself is turning 0', async () => {
    const cards = [person('card-robin', 'Robin Fairweather', birth({ day: 3, month: 3, year: 1990 }))]
    const before = await listUpcomingBirthdays(makeDeps(cards), {
      args: args({ days: 366, from: '1980-01-01' }),
      token: 'tok',
    })
    expect(before.content[0]?.text).toContain('No birthdays')
    expect(before.content[0]?.text).not.toContain('turning -')

    const born = await listUpcomingBirthdays(makeDeps(cards), {
      args: args({ days: 7, from: '1990-03-01' }),
      token: 'tok',
    })
    expect(born.content[0]?.text).toContain('Robin Fairweather — 1990-03-03 (in 2 days, turning 0)')
  })

  test('the empty window says so and points at update_contact', async () => {
    const result = await listUpcomingBirthdays(makeDeps([person('card-none', 'No Birthday')]), {
      args: args(),
      token: 'tok',
    })
    const text = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(text).toContain('No birthdays in the next 30 day(s)')
    expect(text).toContain('update_contact')
  })

  test('a full query window adds the incompleteness note', async () => {
    const cards = Array.from({ length: CARD_CAP + 1 }, (_, i) =>
      person(`card-${i}`, `Person ${i}`, i === 0 ? birth({ day: 20, month: 9 }) : undefined)
    )
    const result = await listUpcomingBirthdays(makeDeps(cards), { args: args(), token: 'tok' })
    expect(result.content[0]?.text).toContain(`${CARD_CAP} cards or more`)
  })

  test('limit truncates and says how to see the rest', async () => {
    const cards = Array.from({ length: 4 }, (_, i) =>
      person(`card-${i}`, `Person ${i}`, birth({ day: 20 + i, month: 9 }))
    )
    const result = await listUpcomingBirthdays(makeDeps(cards), { args: args({ limit: 2 }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    // The header counts everything in the window; the trailer says what was cut.
    expect(text).toContain('4 upcoming birthday(s)')
    expect(text).toContain('Showing the first 2 of 4')
    expect(text).not.toContain('Person 2')
  })

  test('defaults from to today in the account’s time zone, UTC when none is set', async () => {
    // 17:30 in Los Angeles on the 18th is already the 19th in UTC: the
    // birthday on the 18th must still be "today" for that user.
    const cards = [person('card-today', 'Today Person', birth({ day: 18, month: 9 }))]
    const instant = new Date('2026-09-19T00:30:00Z')
    const zoned = await listUpcomingBirthdays(makeDeps(cards, 'America/Los_Angeles'), {
      args: listUpcomingBirthdaysInput.parse({ days: 7 }),
      now: instant,
      token: 'tok',
    })
    expect(zoned.content[0]?.text).toContain('Today Person — 2026-09-18 (today)')

    const utc = await listUpcomingBirthdays(makeDeps(cards), {
      args: listUpcomingBirthdaysInput.parse({ days: 7 }),
      now: instant,
      token: 'tok',
    })
    expect(utc.content[0]?.text).toContain('No birthdays in the next 7 day(s) from 2026-09-19')
  })

  test('a card without a name is listed under its best address', async () => {
    const cards = [{ ...person('card-anon', 'x', birth({ day: 20, month: 9 })), name: undefined }]
    const result = await listUpcomingBirthdays(makeDeps(cards), { args: args(), token: 'tok' })
    expect(result.content[0]?.text).toContain('1. card-anon@northwind.example — 2026-09-20')
  })

  test('a malformed from is an error', async () => {
    const result = await listUpcomingBirthdays(makeDeps([]), { args: args({ from: '18.09.2026' }), token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('YYYY-MM-DD')
  })
})

describe('listUpcomingBirthdaysInput', () => {
  test('defaults and bounds', () => {
    const parsed = listUpcomingBirthdaysInput.parse({})
    expect(parsed.days).toBe(30)
    expect(parsed.limit).toBe(25)
    expect(parsed.from).toBeUndefined()
    expect(listUpcomingBirthdaysInput.safeParse({ days: 0 }).success).toBe(false)
    expect(listUpcomingBirthdaysInput.safeParse({ days: 367 }).success).toBe(false)
    expect(listUpcomingBirthdaysInput.safeParse({ limit: 101 }).success).toBe(false)
  })
})
