import { describe, expect, test } from 'bun:test'

import {
  allDayEndError,
  dateOnlyToInstant,
  type EventTimes,
  type EventTimesResolution,
  eventTimeSchema,
  instantToDateOnly,
  isDateOnly,
  isValidTimeZone,
  resolveEventTimes,
  resolveInputDateTime,
  timeZoneSchema,
  toWallClockIso,
  toZonedDate,
  UTC_TIME_ZONE,
} from './timezone.ts'

// A summer instant: Europe/Berlin is at +02:00 here, so a zone-dependent
// result cannot be mistaken for the UTC value it would carry in winter.
const SUMMER = new Date('2026-07-01T10:00:00Z')

// Narrows a resolution to its times, failing with the refusal reason rather
// than with `Received: false` when the call did not succeed.
const resolved = (resolution: EventTimesResolution): EventTimes => {
  if (!resolution.ok) {
    throw new Error(`expected resolved times, got: ${resolution.error}`)
  }
  return resolution.value
}

describe('UTC_TIME_ZONE', () => {
  test('is the IANA name, not an offset', () => {
    expect(UTC_TIME_ZONE).toBe('UTC')
  })
})

describe('isValidTimeZone', () => {
  test('accepts UTC and IANA zone names', () => {
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('Pacific/Chatham')).toBe(true)
    // A legacy Etc zone, which the canonical list does carry.
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true)
  })

  test('rejects names no zone database knows', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('Europe')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  test('accepts what Intl accepts beyond the canonical list', () => {
    // Neither is in Intl.supportedValuesOf, so both reach the DateTimeFormat
    // fallback: a deprecated alias, and a mixed-case spelling (zone matching
    // is case-insensitive there, though the canonical-list check is not).
    expect(isValidTimeZone('Asia/Calcutta')).toBe(true)
    expect(isValidTimeZone('europe/berlin')).toBe(true)
  })

  test('accepts a bare UTC offset, which is not an IANA name', () => {
    // Intl.DateTimeFormat takes offset strings as a timeZone, so the check is
    // looser than its own error message claims. Pinned as today's behaviour.
    expect(isValidTimeZone('+02:00')).toBe(true)
  })
})

describe('timeZoneSchema', () => {
  test('passes a valid zone through unchanged', () => {
    expect(timeZoneSchema.parse('Europe/Berlin')).toBe('Europe/Berlin')
  })

  test('refuses an unknown zone with a message naming an example', () => {
    const result = timeZoneSchema.safeParse('Mars/Olympus')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('timeZone must be a valid IANA timezone, e.g. Europe/Berlin')
  })
})

describe('eventTimeSchema', () => {
  test('accepts a bare date and a date-time with or without an offset', () => {
    expect(eventTimeSchema.safeParse('2026-10-03').success).toBe(true)
    expect(eventTimeSchema.safeParse('2026-10-03T10:00:00').success).toBe(true)
    expect(eventTimeSchema.safeParse('2026-10-03T10:00:00+02:00').success).toBe(true)
    expect(eventTimeSchema.safeParse('2026-10-03T10:00:00Z').success).toBe(true)
  })

  test('rejects a non-ISO shape and an out-of-range date', () => {
    expect(eventTimeSchema.safeParse('2026-10-03 10:00').success).toBe(false)
    expect(eventTimeSchema.safeParse('03.10.2026').success).toBe(false)
    expect(eventTimeSchema.safeParse('2026-13-45').success).toBe(false)
  })
})

describe('isDateOnly', () => {
  test('is true only for a bare ISO date', () => {
    expect(isDateOnly('2026-10-03')).toBe(true)
    expect(isDateOnly('2026-10-03T00:00:00')).toBe(false)
    expect(isDateOnly(undefined)).toBe(false)
  })

  test('tests the shape, not the calendar', () => {
    // Range is eventTimeSchema's job; this predicate only answers "all-day?".
    expect(isDateOnly('2026-13-45')).toBe(true)
  })
})

describe('dateOnlyToInstant and instantToDateOnly', () => {
  test('a date becomes its UTC midnight', () => {
    expect(dateOnlyToInstant('2026-10-03').toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })

  test('an instant becomes its UTC calendar date', () => {
    expect(instantToDateOnly(new Date('2026-10-03T23:59:59Z'))).toBe('2026-10-03')
    expect(instantToDateOnly(new Date('2026-10-04T02:30:00Z'))).toBe('2026-10-04')
  })

  test('round-trips a date through the instant form', () => {
    expect(instantToDateOnly(dateOnlyToInstant('2026-10-03'))).toBe('2026-10-03')
    expect(instantToDateOnly(dateOnlyToInstant('2026-12-31'))).toBe('2026-12-31')
  })

  test('rolls a day that does not exist over, because Date parses it', () => {
    // 2026 is not a leap year, so this is not a round trip: Date's parsing
    // carries the surplus day into March rather than refusing the input.
    expect(instantToDateOnly(dateOnlyToInstant('2026-02-29'))).toBe('2026-03-01')
  })
})

describe('resolveEventTimes on an all-day event', () => {
  test('resolves both ends to UTC midnights', () => {
    expect(resolveEventTimes('2026-10-03', '2026-10-04', 'Europe/Berlin', true)).toEqual({
      ok: true,
      value: {
        allDay: true,
        end: new Date('2026-10-04T00:00:00Z'),
        start: new Date('2026-10-03T00:00:00Z'),
      },
    })
  })

  test('ignores the time zone entirely', () => {
    // Pinned against literals, not against another call of the same function:
    // a zone creeping into all-day resolution would break both sides alike.
    expect(resolveEventTimes('2026-10-03', '2026-10-04', 'Pacific/Kiritimati', true)).toEqual({
      ok: true,
      value: {
        allDay: true,
        end: new Date('2026-10-04T00:00:00Z'),
        start: new Date('2026-10-03T00:00:00Z'),
      },
    })
  })

  test('refuses an inclusive end, naming the exclusive value to use', () => {
    const result = resolveEventTimes('2026-10-31', '2026-10-31', 'UTC', false)
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('expected a refusal')
    }
    expect(result.error).toBe(allDayEndError('2026-10-31'))
    expect(result.error).toContain('pass end 2026-11-01')
  })

  test('refuses an end before its start', () => {
    expect(resolveEventTimes('2026-10-04', '2026-10-03', 'UTC', false)).toEqual({
      error: allDayEndError('2026-10-04'),
      ok: false,
    })
  })
})

describe('resolveEventTimes on a timed event', () => {
  test('reads naive clock digits as wall-clock time in the zone', () => {
    // Compared as instants: the wall-clock path returns TZDate instances, so
    // a structural match here would lean on how TZDate and Date compare.
    const times = resolved(resolveEventTimes('2026-07-01T12:00:00', '2026-07-01T13:00:00', 'Europe/Berlin', false))
    expect(times.allDay).toBe(false)
    expect(times.start.getTime()).toBe(SUMMER.getTime())
    expect(times.end.getTime()).toBe(new Date('2026-07-01T11:00:00Z').getTime())
  })

  test('honours an offset in the string when the zone was not explicit', () => {
    // 'Europe/Berlin' is passed and deliberately ignored: it is the
    // explicitTimeZone flag, not the absence of a zone, that hands the string
    // to `new Date`. That branch returns a plain Date rather than a TZDate, so
    // toISOString is safe to assert on here, unlike the wall-clock cases above.
    const times = resolved(
      resolveEventTimes('2026-07-01T12:00:00+05:00', '2026-07-01T13:00:00+05:00', 'Europe/Berlin', false)
    )
    expect(times.allDay).toBe(false)
    expect(times.start.toISOString()).toBe('2026-07-01T07:00:00.000Z')
    expect(times.end.toISOString()).toBe('2026-07-01T08:00:00.000Z')
  })

  test('an explicit time zone overrides an offset in the string', () => {
    const result = resolveEventTimes('2026-07-01T12:00:00Z', '2026-07-01T13:00:00Z', 'Europe/Berlin', true)
    expect(resolved(result).start.getTime()).toBe(SUMMER.getTime())
  })

  test('refuses an end at or before its start', () => {
    const message = 'Event end must be after its start.'
    expect(resolveEventTimes('2026-07-01T13:00:00', '2026-07-01T12:00:00', 'UTC', false)).toEqual({
      error: message,
      ok: false,
    })
    expect(resolveEventTimes('2026-07-01T12:00:00', '2026-07-01T12:00:00', 'UTC', false)).toEqual({
      error: message,
      ok: false,
    })
  })
})

describe('resolveEventTimes on a mismatched pair', () => {
  test('refuses one date and one date-time, either way round', () => {
    const message =
      'Pass `start` and `end` both as dates (YYYY-MM-DD) for an all-day event, or both as date-times for a timed one.'
    expect(resolveEventTimes('2026-10-03', '2026-10-03T10:00:00', 'UTC', false)).toEqual({
      error: message,
      ok: false,
    })
    expect(resolveEventTimes('2026-10-03T10:00:00', '2026-10-04', 'UTC', false)).toEqual({
      error: message,
      ok: false,
    })
  })
})

// Both ends are date-times here, so these are *matched* pairs that reach the
// timed branch — the pair-shape check above has already passed.
describe('resolveEventTimes on an unparseable date-time', () => {
  test('throws on a value that is not a date-time at all', () => {
    expect(() => resolveEventTimes('not-a-time', 'also-not', 'UTC', false)).toThrow('invalid date-time: not-a-time')
  })

  test('eventTimeSchema refuses the date-times the parser cannot read', () => {
    // Minute precision and four fractional digits used to pass the schema and
    // then throw in resolveEventTimes, escaping the EventTimesResolution
    // contract. The schema now refuses them, with the form to send instead.
    for (const value of ['2026-10-03T10:00', '2026-10-03T10:00:00.1234']) {
      const result = eventTimeSchema.safeParse(value)
      expect(result.success).toBe(false)
      expect(JSON.stringify(result.error?.issues)).toContain('a date-time with seconds')
    }
  })

  test('eventTimeSchema keeps every form the parser reads', () => {
    for (const value of [
      '2026-10-03T10:00:00',
      '2026-10-03T10:00:00.1',
      '2026-10-03T10:00:00.123',
      '2026-10-03T10:00:00Z',
      '2026-10-03T10:00:00.123Z',
      '2026-10-03T10:00:00+02:00',
      '2026-10-03T10:00:00.5-05:30',
    ]) {
      expect(eventTimeSchema.safeParse(value).success).toBe(true)
    }
  })

  test('every pair eventTimeSchema admits resolves without throwing', () => {
    const admitted = [
      '2026-10-03',
      '2026-10-03T10:00',
      '2026-10-03T10:00:00',
      '2026-10-03T10:00:00.1',
      '2026-10-03T10:00:00.123',
      '2026-10-03T10:00:00.1234',
      '2026-10-03T10:00:00Z',
      '2026-10-03T10:00Z',
      '2026-10-03T10:00:00+02:00',
      '2026-10-03T10:00:00.5-05:30',
    ].filter((value) => eventTimeSchema.safeParse(value).success)
    expect(admitted).toEqual([
      '2026-10-03',
      '2026-10-03T10:00:00',
      '2026-10-03T10:00:00.1',
      '2026-10-03T10:00:00.123',
      '2026-10-03T10:00:00Z',
      '2026-10-03T10:00:00+02:00',
      '2026-10-03T10:00:00.5-05:30',
    ])
    // update_calendar_event resolves a lone end through resolveInputDateTime
    // (a bare date takes the dateOnlyToInstant branch before it).
    for (const value of admitted.filter((admittedValue) => !isDateOnly(admittedValue))) {
      for (const explicitTimeZone of [false, true]) {
        expect(() => resolveInputDateTime(value, 'Europe/Berlin', explicitTimeZone)).not.toThrow()
      }
    }
    for (const start of admitted) {
      for (const end of admitted) {
        for (const explicitTimeZone of [false, true]) {
          expect(() => resolveEventTimes(start, end, 'Europe/Berlin', explicitTimeZone)).not.toThrow()
        }
      }
    }
  })

  test('reads minute precision only on the offset branch', () => {
    // hasExplicitOffset routes the same clock digits to two different parsers:
    // `new Date` takes minute precision, parseWallClockInZone does not. So this
    // value resolves or throws depending on the offset and on explicitTimeZone.
    // eventTimeSchema refuses minute precision with or without an offset, so
    // neither call here can come from a caller — the gap this test pins is in
    // the routing, not in what callers can send.
    expect(eventTimeSchema.safeParse('2026-10-03T10:00Z').success).toBe(false)
    const resolvedPair = resolveEventTimes('2026-10-03T10:00Z', '2026-10-03T11:00Z', 'UTC', false)
    expect(resolved(resolvedPair).start.toISOString()).toBe('2026-10-03T10:00:00.000Z')
    expect(() => resolveEventTimes('2026-10-03T10:00Z', '2026-10-03T11:00Z', 'UTC', true)).toThrow(
      'invalid date-time: 2026-10-03T10:00Z'
    )
  })
})

describe('allDayEndError', () => {
  test('names the day after, across a month and a year boundary', () => {
    expect(allDayEndError('2026-10-31')).toContain('pass end 2026-11-01')
    expect(allDayEndError('2026-12-31')).toContain('pass end 2027-01-01')
    expect(allDayEndError('2028-02-28')).toContain('pass end 2028-02-29')
  })

  test('explains why the end is exclusive', () => {
    expect(allDayEndError('2026-10-03')).toBe(
      "An all-day event's `end` is exclusive — the day after its last day. " +
        'For a single day on 2026-10-03, pass end 2026-10-04.'
    )
  })
})

describe('toZonedDate', () => {
  test('hands back the very same instant for UTC', () => {
    expect(toZonedDate(SUMMER, UTC_TIME_ZONE)).toBe(SUMMER)
  })

  test('keeps the instant but reads out the zone wall clock', () => {
    const zoned = toZonedDate(SUMMER, 'Europe/Berlin')
    expect(zoned.getTime()).toBe(SUMMER.getTime())
    expect(zoned.getHours()).toBe(12)
  })
})

describe('toWallClockIso', () => {
  test('writes the zone wall clock with no offset suffix', () => {
    expect(toWallClockIso(SUMMER, 'Europe/Berlin')).toBe('2026-07-01T12:00:00')
    expect(toWallClockIso(SUMMER, 'America/New_York')).toBe('2026-07-01T06:00:00')
    expect(toWallClockIso(SUMMER, UTC_TIME_ZONE)).toBe('2026-07-01T10:00:00')
  })

  test('follows the zone across a DST change', () => {
    // Berlin is +01:00 in January and +02:00 after the March transition.
    expect(toWallClockIso(new Date('2026-01-15T08:05:03Z'), 'Europe/Berlin')).toBe('2026-01-15T09:05:03')
    expect(toWallClockIso(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin')).toBe('2026-03-29T03:30:00')
  })

  test('zero-pads every field', () => {
    expect(toWallClockIso(new Date('2026-03-05T00:00:00Z'), UTC_TIME_ZONE)).toBe('2026-03-05T00:00:00')
  })

  test('is the inverse of resolveInputDateTime to second precision', () => {
    const iso = toWallClockIso(SUMMER, 'Europe/Berlin')
    expect(resolveInputDateTime(iso, 'Europe/Berlin', false).getTime()).toBe(SUMMER.getTime())
  })

  test('drops milliseconds, so the round trip is lossy below a second', () => {
    const withMillis = new Date('2026-07-01T10:00:00.250Z')
    expect(toWallClockIso(withMillis, 'Europe/Berlin')).toBe('2026-07-01T12:00:00')
    expect(resolveInputDateTime(toWallClockIso(withMillis, 'Europe/Berlin'), 'Europe/Berlin', false).getTime()).toBe(
      SUMMER.getTime()
    )
  })
})

describe('resolveInputDateTime', () => {
  test('reads a naive string as wall-clock time in the zone', () => {
    // The wall-clock path returns a TZDate, which renders itself in its own
    // zone — so these cases compare the instant, not the ISO string.
    expect(resolveInputDateTime('2026-07-01T12:00:00', 'Europe/Berlin', false).getTime()).toBe(SUMMER.getTime())
  })

  test('honours an offset the string carries when the zone was not explicit', () => {
    expect(resolveInputDateTime('2026-07-01T12:00:00+05:00', 'Europe/Berlin', false).toISOString()).toBe(
      '2026-07-01T07:00:00.000Z'
    )
    expect(resolveInputDateTime('2026-07-01T12:00:00Z', 'Europe/Berlin', false).toISOString()).toBe(
      '2026-07-01T12:00:00.000Z'
    )
  })

  test('discards the offset when the caller named a zone', () => {
    // An explicit `timeZone` argument wins: the clock digits are re-read there.
    expect(resolveInputDateTime('2026-07-01T12:00:00Z', 'Europe/Berlin', true).getTime()).toBe(SUMMER.getTime())
    expect(resolveInputDateTime('2026-07-01T12:00:00+05:00', 'Europe/Berlin', true).getTime()).toBe(SUMMER.getTime())
  })

  test('resolves a wall clock that does not exist in the zone', () => {
    // 02:30 is skipped in Berlin on 2026-03-29: the clock jumps 02:00 -> 03:00.
    // Which instant comes back is @date-fns/tz's choice, not ours, so this is
    // pinned to catch a dependency regression rather than to bless an answer.
    // Unlike the ambiguous case below, this direction was the same under every
    // host zone checked (UTC, Europe/Berlin, Asia/Kolkata, America/Anchorage,
    // Australia/Lord_Howe), so an exact instant is safe to assert. If it ever
    // fails on one runner and not another, the host zone is the thing to look
    // at first: docs/upstream/date-fns-tz/ambiguous-wall-clock-depends-on-system-zone.md
    const at = resolveInputDateTime('2026-03-29T02:30:00', 'Europe/Berlin', false)
    expect(at.getTime()).toBe(new Date('2026-03-29T01:30:00Z').getTime())
  })

  test('resolves a wall clock that happens twice to one of its two instants', () => {
    // 02:30 occurs twice in Berlin on 2026-10-25, once at +02:00 and once at
    // +01:00. Which one @date-fns/tz returns depends on the *host* process's
    // local zone — +01:00 under TZ=UTC, +02:00 under TZ=Asia/Kolkata — so only
    // the weaker claim is stable enough to assert. Pinned this way on purpose:
    // asserting either instant would make the suite fail on a non-UTC runner.
    // See docs/upstream/date-fns-tz/ambiguous-wall-clock-depends-on-system-zone.md
    const at = resolveInputDateTime('2026-10-25T02:30:00', 'Europe/Berlin', false)
    expect([new Date('2026-10-25T00:30:00Z').getTime(), new Date('2026-10-25T01:30:00Z').getTime()]).toContain(
      at.getTime()
    )
  })

  test('keeps milliseconds on a wall-clock string', () => {
    expect(resolveInputDateTime('2026-07-01T12:00:00.250', 'Europe/Berlin', false).getTime()).toBe(
      new Date('2026-07-01T10:00:00.250Z').getTime()
    )
  })
})
