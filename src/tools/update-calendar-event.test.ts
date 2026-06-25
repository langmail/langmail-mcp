import { describe, expect, test } from 'bun:test'

import type { FetchEventParams, UpdateEventParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import type { CalendarObject, DiscoveredAccount } from '../caldav/types.ts'
import { type UpdateCalendarEventArgs, updateCalendarEvent, updateCalendarEventInput } from './update-calendar-event.ts'

const CAL = 'https://m/dav/cal/u/default/'
const UID = 'evt-1@langmail.me'

const account = (over: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  calendars: [{ displayName: 'Default', url: CAL }],
  defaultCalendarUrl: CAL,
  organizer: 'host@langmail.me',
  ...over,
})

const args = (over: Partial<UpdateCalendarEventArgs> = {}): UpdateCalendarEventArgs => ({
  attendees: ['guest@example.com'],
  end: '2026-06-12T11:30:00Z',
  start: '2026-06-12T11:00:00Z',
  title: 'Sync (moved)',
  uid: UID,
  ...over,
})

// An existing stored object the agent is editing. SEQUENCE 2 → update bumps to 3.
const storedEvent = (over: Partial<CalendarObject> = {}): CalendarObject => ({
  data: buildInvite({
    attendees: ['guest@example.com'],
    end: new Date('2026-06-12T10:30:00Z'),
    organizer: 'host@langmail.me',
    sequence: 2,
    start: new Date('2026-06-12T10:00:00Z'),
    title: 'Sync',
    uid: UID,
  }),
  etag: '"abc"',
  url: `${CAL}${UID}.ics`,
  ...over,
})

interface Captured {
  fetched: FetchEventParams[]
  updated: UpdateEventParams[]
}

const makeDeps = (acc: DiscoveredAccount, existing: CalendarObject | null, captured: Captured) => ({
  discover: () => Promise.resolve(acc),
  fetchEvent: (p: FetchEventParams) => {
    captured.fetched.push(p)
    return Promise.resolve(existing)
  },
  updateEvent: (p: UpdateEventParams) => {
    captured.updated.push(p)
    return Promise.resolve()
  },
})

const captured = (): Captured => ({ fetched: [], updated: [] })

describe('updateCalendarEventInput schema', () => {
  test('requires a uid', () => {
    const { uid: _uid, ...rest } = args()
    expect(updateCalendarEventInput.safeParse(rest).success).toBe(false)
  })

  test('accepts a valid edit', () => {
    expect(updateCalendarEventInput.safeParse(args()).success).toBe(true)
  })
})

describe('updateCalendarEvent', () => {
  test('PUTs the rebuilt invite back to the existing object URL with a bumped SEQUENCE', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args(),
      token: 'tok',
    })

    expect(cap.fetched[0]).toEqual({ calendarUrl: CAL, token: 'tok', uid: UID })
    expect(cap.updated).toHaveLength(1)
    const put = cap.updated[0]
    expect(put?.url).toBe(`${CAL}${UID}.ics`)
    expect(put?.etag).toBe('"abc"')
    const ical = (put?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('METHOD:REQUEST')
    expect(ical).toContain('SEQUENCE:3')
    expect(ical).toContain(`UID:${UID}`)
    expect(ical).toContain('SUMMARY:Sync (moved)')

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('updated')
  })

  test('re-rules the whole series when recurrence is given', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ recurrence: 'FREQ=WEEKLY;BYDAY=TH' }),
      token: 'tok',
    })
    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH')
    // SEQUENCE still bumps for a recurring edit.
    expect(ical).toContain('SEQUENCE:3')
  })

  test('collapses a series to a one-off when recurrence is omitted', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), { args: args(), token: 'tok' })
    expect(cap.updated[0]?.ical ?? '').not.toContain('RRULE')
  })

  test('errors when the event does not exist', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), null, cap), { args: args(), token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(UID)
    expect(cap.updated).toHaveLength(0)
  })

  test('errors when the explicit calendarUrl is unknown (without fetching)', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ calendarUrl: 'https://m/dav/cal/u/ghost/' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('ghost')
    expect(cap.fetched).toHaveLength(0)
    expect(cap.updated).toHaveLength(0)
  })

  test('errors when the account has no organizer address', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account({ organizer: null }), storedEvent(), cap), {
      args: args(),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  test('errors when end is not after start', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ end: '2026-06-12T11:00:00Z', start: '2026-06-12T11:00:00Z' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })
})
