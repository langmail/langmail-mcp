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
