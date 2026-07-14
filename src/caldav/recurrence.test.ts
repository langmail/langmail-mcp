import { describe, expect, test } from 'bun:test'

import { isSeriesOccurrence, recurrenceSchema, toRRule } from './recurrence.ts'

describe('recurrenceSchema', () => {
  test('accepts a raw RRULE string', () => {
    expect(recurrenceSchema.safeParse('FREQ=WEEKLY;BYDAY=TH').success).toBe(true)
  })

  test('accepts a raw RRULE string with an RRULE: prefix', () => {
    expect(recurrenceSchema.safeParse('RRULE:FREQ=DAILY;COUNT=10').success).toBe(true)
  })

  test('rejects a non-RRULE string', () => {
    expect(recurrenceSchema.safeParse('every thursday').success).toBe(false)
  })

  // A CRLF in a raw rule would let ical-generator splice extra VEVENT content
  // lines (a second SUMMARY, an ATTENDEE, …) into the outgoing invite.
  test('rejects a raw RRULE containing a line break', () => {
    expect(recurrenceSchema.safeParse('FREQ=WEEKLY\r\nSUMMARY:HACKED').success).toBe(false)
  })

  test('accepts a structured object', () => {
    expect(recurrenceSchema.safeParse({ byDay: ['TH'], frequency: 'weekly', interval: 1 }).success).toBe(true)
  })

  test('rejects a structured object without a frequency', () => {
    expect(recurrenceSchema.safeParse({ byDay: ['TH'] }).success).toBe(false)
  })

  test('rejects an unknown weekday code', () => {
    expect(recurrenceSchema.safeParse({ byDay: ['XX'], frequency: 'weekly' }).success).toBe(false)
  })

  test('rejects both until and count', () => {
    const parsed = recurrenceSchema.safeParse({
      count: 12,
      frequency: 'weekly',
      until: '2026-12-31T00:00:00Z',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('toRRule', () => {
  test('returns a raw RRULE string unchanged', () => {
    expect(toRRule('FREQ=WEEKLY;BYDAY=TH')).toBe('FREQ=WEEKLY;BYDAY=TH')
  })

  test('strips a leading RRULE: prefix from a raw string', () => {
    expect(toRRule('RRULE:FREQ=DAILY')).toBe('FREQ=DAILY')
  })

  test('builds a weekly RRULE from the structured form', () => {
    expect(toRRule({ byDay: ['TH'], frequency: 'weekly', interval: 1 })).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TH')
  })

  test('uppercases the frequency', () => {
    expect(toRRule({ frequency: 'monthly' })).toBe('FREQ=MONTHLY')
  })

  test('emits COUNT when given', () => {
    expect(toRRule({ count: 12, frequency: 'weekly' })).toBe('FREQ=WEEKLY;COUNT=12')
  })

  test('emits UNTIL as a compact UTC date-time', () => {
    expect(toRRule({ frequency: 'weekly', until: '2026-12-31T00:00:00Z' })).toBe('FREQ=WEEKLY;UNTIL=20261231T000000Z')
  })

  test('normalizes an offset UNTIL to UTC', () => {
    // 2026-12-31T02:00:00+02:00 == 2026-12-31T00:00:00Z
    expect(toRRule({ frequency: 'weekly', until: '2026-12-31T02:00:00+02:00' })).toBe(
      'FREQ=WEEKLY;UNTIL=20261231T000000Z'
    )
  })

  test('joins multiple byDay codes with commas', () => {
    expect(toRRule({ byDay: ['MO', 'WE', 'FR'], frequency: 'weekly' })).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')
  })
})

describe('isSeriesOccurrence', () => {
  // Master: every Tuesday at 10:00Z starting 2026-06-16 (itself a Tuesday).
  const start = '2026-06-16T10:00:00Z'
  const weekly = 'FREQ=WEEKLY;BYDAY=TU'

  test('accepts the master start itself', () => {
    expect(isSeriesOccurrence(start, weekly, '2026-06-16T10:00:00Z')).toBe(true)
  })

  test('accepts a later occurrence on the rule', () => {
    expect(isSeriesOccurrence(start, weekly, '2026-06-23T10:00:00Z')).toBe(true)
  })

  test('rejects a date that is not on the weekday', () => {
    expect(isSeriesOccurrence(start, weekly, '2026-06-24T10:00:00Z')).toBe(false)
  })

  test('rejects the right day at the wrong time', () => {
    expect(isSeriesOccurrence(start, weekly, '2026-06-23T11:00:00Z')).toBe(false)
  })

  test('rejects an instant before the series begins', () => {
    expect(isSeriesOccurrence(start, weekly, '2026-06-09T10:00:00Z')).toBe(false)
  })

  test('accepts an offset instant that is the same UTC moment', () => {
    // 2026-06-23T12:00:00+02:00 == 2026-06-23T10:00:00Z
    expect(isSeriesOccurrence(start, weekly, '2026-06-23T12:00:00+02:00')).toBe(true)
  })

  test('honours COUNT — rejects an instant past the final occurrence', () => {
    // COUNT=3 → 06-16, 06-23, 06-30; 07-07 is the 4th and out of range.
    expect(isSeriesOccurrence(start, 'FREQ=WEEKLY;COUNT=3', '2026-06-30T10:00:00Z')).toBe(true)
    expect(isSeriesOccurrence(start, 'FREQ=WEEKLY;COUNT=3', '2026-07-07T10:00:00Z')).toBe(false)
  })

  test('honours UNTIL — rejects an instant after the bound', () => {
    const until = 'FREQ=WEEKLY;UNTIL=20260623T100000Z'
    expect(isSeriesOccurrence(start, until, '2026-06-23T10:00:00Z')).toBe(true)
    expect(isSeriesOccurrence(start, until, '2026-06-30T10:00:00Z')).toBe(false)
  })
})
