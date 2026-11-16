import { describe, expect, test } from 'bun:test'

import { type DeleteEventParams, type FetchEventParams, type UpdateEventParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { type DeleteCalendarEventArgs, deleteCalendarEvent, deleteCalendarEventInput } from './delete-calendar-event.ts'

const CAL = 'https://m/dav/cal/u/default/'
const UID = 'evt-1@langmail.me'

const account = (over: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  calendars: [{ displayName: 'Default', url: CAL }],
  defaultCalendarUrl: CAL,
  organizer: 'host@langmail.me',
  ...over,
})

const args = (over: Partial<DeleteCalendarEventArgs> = {}): DeleteCalendarEventArgs => ({
  uid: UID,
  ...over,
})

const storedEvent = (over: Partial<CalendarObject> = {}): CalendarObject => ({
  data: 'BEGIN:VEVENT\r\nUID:evt-1@langmail.me\r\nEND:VEVENT',
  etag: '"abc"',
  url: `${CAL}${UID}.ics`,
  ...over,
})

// A stored recurring master: Tuesdays 10:00Z from 2026-06-16, so 2026-06-23T10:00:00Z
// is a valid occurrence and e.g. 2026-06-24 (a Wednesday) is not.
const recurringStored = (over: Partial<CalendarObject> = {}): CalendarObject => ({
  data: buildInvite({
    attendees: ['guest@example.com'],
    end: new Date('2026-06-16T10:30:00Z'),
    organizer: 'host@langmail.me',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    sequence: 2,
    start: new Date('2026-06-16T10:00:00Z'),
    title: 'Weekly Sync',
    uid: UID,
  }),
  etag: '"abc"',
  url: `${CAL}${UID}.ics`,
  ...over,
})

interface Captured {
  deleted: DeleteEventParams[]
  fetched: FetchEventParams[]
  updated: UpdateEventParams[]
}

const makeDeps = (acc: DiscoveredAccount, existing: CalendarObject | null, capturedState: Captured) => ({
  deleteEvent: (p: DeleteEventParams) => {
    capturedState.deleted.push(p)
    return Promise.resolve()
  },
  discover: () => Promise.resolve(acc),
  fetchEvent: (p: FetchEventParams) => {
    capturedState.fetched.push(p)
    return Promise.resolve(existing)
  },
  updateEvent: (p: UpdateEventParams) => {
    capturedState.updated.push(p)
    return Promise.resolve()
  },
})

const captured = (): Captured => ({ deleted: [], fetched: [], updated: [] })

describe('deleteCalendarEventInput schema', () => {
  test('requires a uid', () => {
    expect(deleteCalendarEventInput.safeParse({}).success).toBe(false)
  })

  test('accepts a uid alone', () => {
    expect(deleteCalendarEventInput.safeParse({ uid: UID }).success).toBe(true)
  })

  test('rejects a uid with a path separator (collection escape)', () => {
    expect(deleteCalendarEventInput.safeParse({ uid: '../private/secret' }).success).toBe(false)
  })

  test('accepts an optional recurrenceId', () => {
    expect(deleteCalendarEventInput.safeParse({ recurrenceId: '2026-06-23T10:00:00Z', uid: UID }).success).toBe(true)
  })

  test('rejects a recurrenceId without an offset', () => {
    expect(deleteCalendarEventInput.safeParse({ recurrenceId: '2026-06-23T10:00:00', uid: UID }).success).toBe(false)
  })
})

describe('deleteCalendarEvent', () => {
  test('DELETEs the resolved object URL with its ETag and reports cancellation', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args(),
      token: 'tok',
    })

    expect(cap.fetched[0]).toEqual({ calendarUrl: CAL, token: 'tok', uid: UID })
    expect(cap.deleted).toHaveLength(1)
    expect(cap.deleted[0]).toEqual({ etag: '"abc"', token: 'tok', url: `${CAL}${UID}.ics` })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('deleted')
  })

  test('omits the If-Match ETag when the stored object has none', async () => {
    const cap = captured()
    await deleteCalendarEvent(makeDeps(account(), storedEvent({ etag: undefined }), cap), {
      args: args(),
      token: 'tok',
    })
    expect(cap.deleted[0]).toEqual({ token: 'tok', url: `${CAL}${UID}.ics` })
  })

  test('errors when the event does not exist', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), null, cap), { args: args(), token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(UID)
    expect(cap.deleted).toHaveLength(0)
  })

  test('errors when the explicit calendarUrl is unknown (without fetching)', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ calendarUrl: 'https://m/dav/cal/u/ghost/' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('ghost')
    expect(cap.fetched).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
  })

  test('errors when there is no calendar to delete from', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(
      makeDeps(account({ calendars: [], defaultCalendarUrl: null }), storedEvent(), cap),
      { args: args(), token: 'tok' }
    )
    expect(result.isError).toBe(true)
    expect(cap.deleted).toHaveLength(0)
  })

  test('never PUTs on the whole-series path', async () => {
    const cap = captured()
    await deleteCalendarEvent(makeDeps(account(), recurringStored(), cap), { args: args(), token: 'tok' })
    // Omitting recurrenceId keeps the byte-for-byte DELETE path — no PUT.
    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(1)
  })
})

describe('deleteCalendarEvent — single occurrence (recurrenceId)', () => {
  const OCCURRENCE = '2026-06-23T10:00:00Z'

  test('PUTs the spliced object (EXDATE, never DELETE) with the stored ETag', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })

    // Cancelling one occurrence rewrites the resource — it must not be DELETEd,
    // or the master and the other occurrences would vanish too.
    expect(cap.deleted).toHaveLength(0)
    expect(cap.updated).toHaveLength(1)
    const put = cap.updated[0]
    expect(put?.url).toBe(`${CAL}${UID}.ics`)
    expect(put?.etag).toBe('"abc"')
    const ical = (put?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('EXDATE:20260623T100000Z')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    // SEQUENCE bumps past the master's 2 so the CANCEL supersedes it.
    expect(ical).toContain('SEQUENCE:3')

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('cancelled')
    expect(result.content[0]?.text).toContain(OCCURRENCE)
  })

  test('short-circuits a double-cancel: no PUT, still reports success', async () => {
    // Pre-exclude the instant so the splice is a no-op (byte-for-byte unchanged).
    const alreadyExcluded = recurringStored({
      data: recurringStored().data.replace('END:VEVENT', 'EXDATE:20260623T100000Z\r\nEND:VEVENT'),
    })
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), alreadyExcluded, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })

    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('cancelled')
  })

  test('rejects a recurrenceId that is not an occurrence of the series', async () => {
    const cap = captured()
    // 2026-06-24 is a Wednesday — not on the Tuesday rule.
    const result = await deleteCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ recurrenceId: '2026-06-24T10:00:00Z' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('occurrence')
    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
  })

  test('rejects cleanly when the master rule cannot be parsed', async () => {
    const cap = captured()
    // A trailing `;` passes create's light RRULE validation and is stored, but
    // the rrule engine throws on it — surface a clear error, never DELETE/PUT.
    const brokenRule = recurringStored({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-16T10:30:00Z'),
        organizer: 'host@langmail.me',
        rrule: 'FREQ=WEEKLY;BYDAY=TU;',
        sequence: 2,
        start: new Date('2026-06-16T10:00:00Z'),
        title: 'Weekly Sync',
        uid: UID,
      }),
    })
    const result = await deleteCalendarEvent(makeDeps(account(), brokenRule, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Could not evaluate')
    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
  })

  test('rejects cancelling an occurrence of a non-recurring event', async () => {
    const cap = captured()
    const oneOff = storedEvent({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-16T10:30:00Z'),
        organizer: 'host@langmail.me',
        start: new Date('2026-06-16T10:00:00Z'),
        title: 'One-off',
        uid: UID,
      }),
    })
    const result = await deleteCalendarEvent(makeDeps(account(), oneOff, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('not a recurring series')
    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
  })

  test('errors when the recurring event does not exist (no PUT)', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), null, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(UID)
    expect(cap.updated).toHaveLength(0)
  })
})

// A master written by another calendar client: an uppercase UUID, a DTSTART in
// Europe/Berlin wall clock backed by its own VTIMEZONE, weekly on Wednesdays at
// 08:15 — so occurrences start at 06:15Z in summer (CEST) and 07:15Z in winter
// (CET). `tzid` swaps in a zone name so the unresolvable case can reuse it.
const foreignZonedStored = (tzid = 'Europe/Berlin'): CalendarObject => ({
  data: [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example Corp//Example Calendar 1.0//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'DTSTART:19810329T020000',
    'TZNAME:CEST',
    'TZOFFSETTO:+0200',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'DTSTART:19961027T030000',
    'TZNAME:CET',
    'TZOFFSETTO:+0100',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'CREATED:20241120T091200Z',
    'UID:0F3A9C1E-7B2D-4E5F-8A6B-1C2D3E4F5A6B',
    `DTEND;TZID=${tzid}:20241127T093000`,
    'RRULE:FREQ=WEEKLY;BYDAY=WE',
    'TRANSP:OPAQUE',
    'SUMMARY:Yoga',
    `DTSTART;TZID=${tzid}:20241127T081500`,
    'DTSTAMP:20241120T091200Z',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'),
  etag: '"foreign"',
  url: `${CAL}0F3A9C1E-7B2D-4E5F-8A6B-1C2D3E4F5A6B.ics`,
})

describe('deleteCalendarEvent — zoned series written by another client', () => {
  const cancel = async (recurrenceId: string, stored = foreignZonedStored()) => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), stored, cap), {
      args: args({ recurrenceId, uid: '0F3A9C1E-7B2D-4E5F-8A6B-1C2D3E4F5A6B' }),
      token: 'tok',
    })
    return { cap, ical: (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, ''), result }
  }

  test.each([
    // 08:15 Berlin in CEST, as a UTC instant.
    ['2026-10-21T06:15:00Z', 'EXDATE;TZID=Europe/Berlin:20261021T081500'],
    // 08:15 Berlin in CET, as a UTC instant.
    ['2026-11-18T07:15:00Z', 'EXDATE;TZID=Europe/Berlin:20261118T081500'],
    // The same CET instant written with its offset.
    ['2026-11-18T08:15:00+01:00', 'EXDATE;TZID=Europe/Berlin:20261118T081500'],
  ])('accepts the occurrence’s true instant %s and excludes its wall clock', async (recurrenceId, exdate) => {
    const { cap, ical, result } = await cancel(recurrenceId)
    expect(result.isError).toBeUndefined()
    expect(cap.updated).toHaveLength(1)
    expect(ical).toContain(exdate)
  })

  test('rejects the wall clock labelled as UTC, which is not an occurrence', async () => {
    // 08:15Z is 09:15 Berlin in CET: no occurrence starts then.
    const { cap, result } = await cancel('2026-11-18T08:15:00Z')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('does not match an occurrence')
    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
  })

  test('cancels an occurrence of a series in a Windows zone, keeping its TZID name', async () => {
    // Outlook names the zone the Windows way; the object's own VTIMEZONE
    // defines that name, so the EXDATE names it too.
    const { cap, ical, result } = await cancel('2026-11-18T07:15:00Z', foreignZonedStored('W. Europe Standard Time'))
    expect(result.isError).toBeUndefined()
    expect(cap.updated).toHaveLength(1)
    expect(ical).toContain('EXDATE;TZID=W. Europe Standard Time:20261118T081500')
  })

  test('fails loudly when the series’ zone cannot be resolved', async () => {
    // A zone name that is neither IANA nor Windows, defined only by the object's VTIMEZONE: matching it as
    // UTC would cancel the wrong instant, so nothing is written.
    const { cap, result } = await cancel('2026-11-18T07:15:00Z', foreignZonedStored('Example Standard Time'))
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Example Standard Time')
    expect(result.content[0]?.text).toContain('2026-11-18T07:15:00Z')
    expect(result.content[0]?.text).toContain('Nothing was cancelled')
    expect(cap.updated).toHaveLength(0)
    expect(cap.deleted).toHaveLength(0)
  })
})

describe('deleteCalendarEvent — all-day series occurrence', () => {
  const allDaySeries = (): CalendarObject =>
    storedEvent({
      data: buildInvite({
        allDay: true,
        attendees: [],
        end: new Date('2026-06-17T00:00:00Z'),
        rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229',
        start: new Date('2026-06-16T00:00:00Z'),
        title: 'Gym',
        uid: UID,
      }),
    })

  test('the schema accepts a date recurrenceId', () => {
    expect(deleteCalendarEventInput.safeParse(args({ recurrenceId: '2026-06-23' })).success).toBe(true)
  })

  test('cancels one day with a DATE-valued EXDATE matching the master', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), allDaySeries(), cap), {
      args: args({ recurrenceId: '2026-06-23' }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(cap.updated[0]?.ical).toContain('EXDATE;VALUE=DATE:20260623')
    expect(result.content[0]?.text).toContain('on 2026-06-23 cancelled')
  })

  test('ignores a TZID written beside an all-day DTSTART', async () => {
    // Off-spec, but some producers write it: the date must still match as a date.
    const zonedAllDay = allDaySeries()
    zonedAllDay.data = zonedAllDay.data.replace('DTSTART;VALUE=DATE:', 'DTSTART;TZID=Europe/Berlin;VALUE=DATE:')
    expect(zonedAllDay.data).toContain('DTSTART;TZID=Europe/Berlin;VALUE=DATE:20260616')
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), zonedAllDay, cap), {
      args: args({ recurrenceId: '2026-06-23' }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(cap.updated[0]?.ical).toContain('EXDATE;VALUE=DATE:20260623')
  })

  test('a date off the all-day series is refused naming the date form', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), allDaySeries(), cap), {
      args: args({ recurrenceId: '2026-06-24' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('original date')
    expect(result.content[0]?.text).toContain('list_calendar_events')
  })

  test('refuses a date-time recurrenceId on an all-day series', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), allDaySeries(), cap), {
      args: args({ recurrenceId: '2026-06-23T00:00:00Z' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  test('refuses a date recurrenceId on a timed series', async () => {
    const cap = captured()
    const result = await deleteCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ recurrenceId: '2026-06-23' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })
})
