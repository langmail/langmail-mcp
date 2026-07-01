import { describe, expect, test } from 'bun:test'

import { type PutEventParams } from '../caldav/client.ts'
import { type DiscoveredAccount } from '../caldav/types.ts'
import { type CreateCalendarEventArgs, createCalendarEvent, createCalendarEventInput } from './create-calendar-event.ts'

const account = (over: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  calendars: [{ displayName: 'Default', url: 'https://m/dav/cal/u/default/' }],
  defaultCalendarUrl: 'https://m/dav/cal/u/default/',
  organizer: 'host@langmail.me',
  ...over,
})

const args = (over: Partial<CreateCalendarEventArgs> = {}): CreateCalendarEventArgs => ({
  attendees: ['guest@example.com'],
  end: '2026-06-12T10:30:00Z',
  start: '2026-06-12T10:00:00Z',
  title: 'Sync',
  ...over,
})

const makeDeps = (acc: DiscoveredAccount, captured: PutEventParams[] = []) => ({
  discover: () => Promise.resolve(acc),
  putEvent: (p: PutEventParams) => {
    captured.push(p)
    return Promise.resolve()
  },
})

describe('createCalendarEventInput schema', () => {
  test('requires at least one attendee', () => {
    expect(createCalendarEventInput.safeParse({ ...args(), attendees: [] }).success).toBe(false)
  })

  test('rejects a non-email attendee', () => {
    expect(createCalendarEventInput.safeParse({ ...args(), attendees: ['nope'] }).success).toBe(false)
  })

  test('rejects a non-ISO start', () => {
    expect(createCalendarEventInput.safeParse({ ...args(), start: 'tomorrow' }).success).toBe(false)
  })

  test('accepts a valid event', () => {
    expect(createCalendarEventInput.safeParse(args()).success).toBe(true)
  })

  test('accepts a raw RRULE recurrence', () => {
    expect(createCalendarEventInput.safeParse({ ...args(), recurrence: 'FREQ=WEEKLY;BYDAY=TH' }).success).toBe(true)
  })

  test('accepts a structured recurrence', () => {
    expect(
      createCalendarEventInput.safeParse({ ...args(), recurrence: { byDay: ['TH'], frequency: 'weekly' } }).success
    ).toBe(true)
  })

  test('rejects a recurrence that sets both until and count', () => {
    expect(
      createCalendarEventInput.safeParse({
        ...args(),
        recurrence: { count: 5, frequency: 'weekly', until: '2026-12-31T00:00:00Z' },
      }).success
    ).toBe(false)
  })
})

describe('createCalendarEvent', () => {
  test('PUTs an invite to the default calendar and reports the attendees', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), { args: args(), token: 'tok' })

    expect(captured).toHaveLength(1)
    const put = captured[0]
    expect(put?.calendarUrl).toBe('https://m/dav/cal/u/default/')
    // Unfold RFC 5545 line folding before matching addresses.
    const ical = (put?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('METHOD:REQUEST')
    expect(ical).toContain('host@langmail.me')
    expect(ical).toContain('guest@example.com')
    expect(put?.uid).toContain('@langmail.me')

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Sync')
    expect(txt).toContain('guest@example.com')
  })

  test('PUTs a recurring invite and reports it as recurring', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), {
      args: args({ recurrence: { byDay: ['TH'], frequency: 'weekly' } }),
      token: 'tok',
    })

    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH')
    expect(result.content[0]?.text).toContain('Recurring event')
  })

  test('honours an explicit calendarUrl that exists', async () => {
    const acc = account({
      calendars: [
        { displayName: 'Default', url: 'https://m/dav/cal/u/default/' },
        { displayName: 'Team', url: 'https://m/dav/cal/u/team/' },
      ],
    })
    const captured: PutEventParams[] = []
    await createCalendarEvent(makeDeps(acc, captured), {
      args: args({ calendarUrl: 'https://m/dav/cal/u/team/' }),
      token: 'tok',
    })
    expect(captured[0]?.calendarUrl).toBe('https://m/dav/cal/u/team/')
  })

  test('accepts an explicit calendarUrl that differs only by a trailing slash', async () => {
    const acc = account({
      calendars: [{ displayName: 'Team', url: 'https://m/dav/cal/u/team/' }],
    })
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(acc, captured), {
      // discovered URL is slashed; agent passes the unslashed form
      args: args({ calendarUrl: 'https://m/dav/cal/u/team' }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(captured[0]?.calendarUrl).toBe('https://m/dav/cal/u/team')
  })

  test('errors when the explicit calendarUrl is unknown', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), {
      args: args({ calendarUrl: 'https://m/dav/cal/u/ghost/' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('ghost')
    expect(captured).toHaveLength(0)
  })

  test('errors when the account has no organizer address', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account({ organizer: null }), captured), {
      args: args(),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  })

  test('errors when there is no calendar to write to', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account({ calendars: [], defaultCalendarUrl: null }), captured), {
      args: args(),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  })

  test('errors when end is not after start', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), {
      args: args({ end: '2026-06-12T10:00:00Z', start: '2026-06-12T10:00:00Z' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  })
})
