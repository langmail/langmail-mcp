import { describe, expect, test } from 'bun:test'

import { recurrenceSchema, toRRule } from './recurrence.ts'

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
