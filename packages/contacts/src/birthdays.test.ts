import { describe, expect, test } from 'bun:test'

import { daysUntil, formatCalendarDate, nextOccurrence, parseCalendarDate, todayIn } from './birthdays.ts'

describe('nextOccurrence', () => {
  test('a birthday later this year stays in this year', () => {
    expect(nextOccurrence({ day: 3, month: 3 }, { day: 18, month: 9, year: 2026 })).toEqual({
      day: 3,
      month: 3,
      year: 2027,
    })
    expect(nextOccurrence({ day: 24, month: 12 }, { day: 18, month: 9, year: 2026 })).toEqual({
      day: 24,
      month: 12,
      year: 2026,
    })
  })

  test('a birthday earlier this year rolls over the year boundary', () => {
    expect(nextOccurrence({ day: 2, month: 1, year: 1990 }, { day: 30, month: 12, year: 2026 })).toEqual({
      day: 2,
      month: 1,
      year: 2027,
    })
  })

  test('a birthday on the from date itself is that date, not next year', () => {
    expect(nextOccurrence({ day: 18, month: 9 }, { day: 18, month: 9, year: 2026 })).toEqual({
      day: 18,
      month: 9,
      year: 2026,
    })
  })

  test('Feb 29 falls on Feb 28 in a non-leap year and on Feb 29 in a leap year', () => {
    expect(nextOccurrence({ day: 29, month: 2 }, { day: 1, month: 1, year: 2027 })).toEqual({
      day: 28,
      month: 2,
      year: 2027,
    })
    expect(nextOccurrence({ day: 29, month: 2 }, { day: 1, month: 1, year: 2028 })).toEqual({
      day: 29,
      month: 2,
      year: 2028,
    })
    // Asked on Feb 28 of a non-leap year: the fallback date is today.
    expect(nextOccurrence({ day: 29, month: 2 }, { day: 28, month: 2, year: 2027 })).toEqual({
      day: 28,
      month: 2,
      year: 2027,
    })
  })
})

describe('daysUntil', () => {
  test('the same day is day 0, tomorrow is day 1', () => {
    const from = { day: 18, month: 9, year: 2026 }
    expect(daysUntil(from, from)).toBe(0)
    expect(daysUntil({ day: 19, month: 9, year: 2026 }, from)).toBe(1)
  })

  test('counts across a month and a year boundary', () => {
    expect(daysUntil({ day: 2, month: 10, year: 2026 }, { day: 18, month: 9, year: 2026 })).toBe(14)
    expect(daysUntil({ day: 2, month: 1, year: 2027 }, { day: 30, month: 12, year: 2026 })).toBe(3)
  })
})

describe('calendar dates', () => {
  test('parses a strict ISO date and rejects impossible ones', () => {
    expect(parseCalendarDate('2026-09-18')).toEqual({ day: 18, month: 9, year: 2026 })
    expect(parseCalendarDate('2024-02-29')).toEqual({ day: 29, month: 2, year: 2024 })
    expect(parseCalendarDate('2023-02-29')).toBeUndefined()
    expect(parseCalendarDate('2026-13-01')).toBeUndefined()
    expect(parseCalendarDate('18.09.2026')).toBeUndefined()
  })

  test('formats zero-padded', () => {
    expect(formatCalendarDate({ day: 3, month: 3, year: 2027 })).toBe('2027-03-03')
  })

  test('today is the user’s calendar day in their zone, not the server’s', () => {
    const instant = new Date('2026-09-19T00:30:00Z')
    expect(todayIn(instant, 'America/Los_Angeles')).toEqual({ day: 18, month: 9, year: 2026 })
    expect(todayIn(instant, 'Europe/Berlin')).toEqual({ day: 19, month: 9, year: 2026 })
    expect(todayIn(instant, 'UTC')).toEqual({ day: 19, month: 9, year: 2026 })
    // An unknown zone degrades to UTC instead of failing the call.
    expect(todayIn(instant, 'Not/AZone')).toEqual({ day: 19, month: 9, year: 2026 })
  })
})
