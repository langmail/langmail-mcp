// Pure calendar arithmetic for "whose birthday is coming up": the next
// occurrence of a month/day on or after a given date, and the distance in
// days. Kept apart from the MCP tool so the year-boundary and leap-day rules
// are unit-tested without an address book.
//
// No `Date` objects cross this boundary. Everything is a `{ year, month,
// day }` triple, and the one place a `Date` is used internally is UTC-only,
// so a birthday can never shift by a day with the server's time zone.

import { type Birthday } from './types.ts'

export interface CalendarDate {
  day: number
  month: number
  year: number
}

const DAY_MS = 86_400_000

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

// Days in a month, February by the year given.
export const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

const epochDay = (d: CalendarDate): number => Date.UTC(d.year, d.month - 1, d.day) / DAY_MS

// The stored month/day placed in a given year. Feb 29 falls on Feb 28 in a
// year that has no Feb 29 — the one convention the tool description states.
const inYear = (birthday: Birthday, year: number): CalendarDate => ({
  day: Math.min(birthday.day, daysInMonth(year, birthday.month)),
  month: birthday.month,
  year,
})

const isBefore = (a: CalendarDate, b: CalendarDate): boolean => epochDay(a) < epochDay(b)

// The next calendar date on or after `from` on which the birthday falls. A
// birthday on `from` itself is `from`.
export const nextOccurrence = (birthday: Birthday, from: CalendarDate): CalendarDate => {
  const thisYear = inYear(birthday, from.year)
  return isBefore(thisYear, from) ? inYear(birthday, from.year + 1) : thisYear
}

// Whole days from `from` to `occurrence`; the same day is 0.
export const daysUntil = (occurrence: CalendarDate, from: CalendarDate): number =>
  Math.round(epochDay(occurrence) - epochDay(from))

// `YYYY-MM-DD`, zero-padded.
export const formatCalendarDate = (d: CalendarDate): string =>
  `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u

// Strict `YYYY-MM-DD` to a calendar date, rejecting impossible dates.
export const parseCalendarDate = (text: string): CalendarDate | undefined => {
  const m = ISO_DATE.exec(text.trim())
  if (!m) {
    return
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return
  }
  return { day, month, year }
}

// Today's date in UTC as a calendar date — the tool's default `from`.
export const todayUtc = (now: Date): CalendarDate => ({
  day: now.getUTCDate(),
  month: now.getUTCMonth() + 1,
  year: now.getUTCFullYear(),
})
