import { describe, expect, test } from 'bun:test'

import { isSeriesOccurrence, recurrenceSchema, startContradictsRule, toRRule } from './recurrence.ts'

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

  // A zoned master (naive wall-clock `start`, no Z, paired with a `timeZone`):
  // the recurrence is evaluated in that zone rather than in UTC.
  describe('with a timeZone', () => {
    test('accepts a UTC instant that is the master wall-clock time in the zone', () => {
      // 08:00Z 2026-06-16 == 10:00 Europe/Berlin (CEST), a Tuesday.
      expect(isSeriesOccurrence('2026-06-16T10:00:00', weekly, '2026-06-16T08:00:00Z', 'Europe/Berlin')).toBe(true)
    })

    test('rejects an instant that lands on the wrong local weekday', () => {
      // 08:00Z 2026-06-17 == 10:00 Europe/Berlin on a Wednesday, not the ruled Tuesday.
      expect(isSeriesOccurrence('2026-06-16T10:00:00', weekly, '2026-06-17T08:00:00Z', 'Europe/Berlin')).toBe(false)
    })

    test('strips a trailing zone-name suffix from a floating masterStart', () => {
      expect(
        isSeriesOccurrence('2026-06-16T10:00:00 Europe/Berlin', weekly, '2026-06-16T08:00:00Z', 'Europe/Berlin')
      ).toBe(true)
    })

    test('keeps the last occurrence of a series bounded by a UTC UNTIL', () => {
      // UNTIL is the last occurrence's true instant (08:15 Berlin, CEST), as
      // RFC 5545 requires it in UTC for a zoned DTSTART.
      const bounded = 'FREQ=WEEKLY;UNTIL=20261021T061500Z'
      expect(isSeriesOccurrence('2026-10-07T08:15:00', bounded, '2026-10-21T06:15:00Z', 'Europe/Berlin')).toBe(true)
      expect(isSeriesOccurrence('2026-10-07T08:15:00', bounded, '2026-10-28T07:15:00Z', 'Europe/Berlin')).toBe(false)
    })

    test('orders a UTC UNTIL inside the DST fall-back hour by instant', () => {
      // 2026-11-01 01:30 New York is first EDT (05:30Z), then EST (06:30Z).
      // UNTIL 06:00Z falls between them, so only the first 01:30 is in range —
      // as wall clock it would read 01:00 and drop that day altogether.
      const bounded = 'FREQ=DAILY;UNTIL=20261101T060000Z'
      expect(isSeriesOccurrence('2026-10-31T01:30:00', bounded, '2026-11-01T05:30:00Z', 'America/New_York')).toBe(true)
      expect(isSeriesOccurrence('2026-10-31T01:30:00', bounded, '2026-11-01T06:30:00Z', 'America/New_York')).toBe(false)
    })
  })
})

describe('startContradictsRule', () => {
  // 2026-06-16 is a Tuesday, 2026-06-19 is the Friday of the same week.
  const tuesday = new Date('2026-06-16T10:00:00Z')
  const friday = new Date('2026-06-19T10:00:00Z')

  test('false when the start falls on the ruled weekday', () => {
    expect(startContradictsRule('FREQ=WEEKLY;BYDAY=TU', tuesday, 'UTC')).toBe(false)
  })

  test('true when the start falls on a different weekday than the rule', () => {
    expect(startContradictsRule('FREQ=WEEKLY;BYDAY=TU', friday, 'UTC')).toBe(true)
  })

  test('false when the rule has no BYDAY', () => {
    expect(startContradictsRule('FREQ=DAILY', friday, 'UTC')).toBe(false)
  })

  test('false when BYDAY is a filter within a larger pattern (BYMONTHDAY present)', () => {
    expect(startContradictsRule('FREQ=MONTHLY;BYMONTHDAY=19;BYDAY=TU', friday, 'UTC')).toBe(false)
  })

  test('false when the start matches any weekday in a multi-day BYDAY', () => {
    expect(startContradictsRule('FREQ=WEEKLY;BYDAY=MO,WE,FR', friday, 'UTC')).toBe(false)
  })

  test('true when the start matches none of a multi-day BYDAY', () => {
    expect(startContradictsRule('FREQ=WEEKLY;BYDAY=MO,WE', friday, 'UTC')).toBe(true)
  })

  test('strips an ordinal prefix from BYDAY before comparing weekdays', () => {
    // FREQ=MONTHLY;BYDAY=2TU ("the second Tuesday") is not caught by the
    // BYSETPOS/BYMONTHDAY/BYYEARDAY/BYWEEKNO guard, so it is judged the same
    // as an unconditional weekly Tuesday rule — current behavior, not a claim
    // that this is the semantically correct call for an ordinal BYDAY. A
    // Tuesday start is required to actually exercise the stripping: on a
    // Friday start both the stripped ('TU') and unstripped ('2TU') forms
    // mismatch and return true either way, so that case can't tell the two
    // apart.
    expect(startContradictsRule('FREQ=MONTHLY;BYDAY=2TU', tuesday, 'UTC')).toBe(false)
  })

  test('evaluates the weekday in the given time zone, not UTC', () => {
    // 02:00Z 2026-06-16 (a UTC Tuesday) is 16:00 the prior day in Honolulu
    // (UTC-10, no DST) — a Monday.
    const crossesMidnight = new Date('2026-06-16T02:00:00Z')
    expect(startContradictsRule('FREQ=WEEKLY;BYDAY=MO', crossesMidnight, 'Pacific/Honolulu')).toBe(false)
    expect(startContradictsRule('FREQ=WEEKLY;BYDAY=TU', crossesMidnight, 'Pacific/Honolulu')).toBe(true)
  })
})
