import { describe, expect, test } from 'bun:test'

import { type FetchEventsParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { type ListCalendarEventsArgs, listCalendarEvents, listCalendarEventsInput } from './list-calendar-events.ts'

const CAL = 'https://m/dav/cal/u/default/'

const account = (over: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  calendars: [{ displayName: 'Default', url: CAL }],
  defaultCalendarUrl: CAL,
  organizer: 'host@langmail.me',
  ...over,
})

const event = (uid: string, title: string, start: string, end: string): CalendarObject => ({
  data: buildInvite({
    attendees: ['guest@example.com'],
    end: new Date(end),
    organizer: 'host@langmail.me',
    start: new Date(start),
    timeZone: 'UTC',
    title,
    uid,
  }),
  url: `${CAL}${uid}.ics`,
})

const makeDeps = (acc: DiscoveredAccount, objects: CalendarObject[], captured: FetchEventsParams[] = []) => ({
  discover: () => Promise.resolve(acc),
  fetchEvents: (p: FetchEventsParams) => {
    captured.push(p)
    return Promise.resolve(objects)
  },
})

describe('listCalendarEventsInput schema', () => {
  test('accepts an empty input', () => {
    expect(listCalendarEventsInput.safeParse({}).success).toBe(true)
  })

  test('rejects a non-ISO start', () => {
    expect(listCalendarEventsInput.safeParse({ start: 'soon' }).success).toBe(false)
  })
})

describe('listCalendarEvents', () => {
  test('lists events sorted by start with their uids', async () => {
    const objects = [
      event('later@langmail.me', 'Later', '2026-06-12T15:00:00Z', '2026-06-12T16:00:00Z'),
      event('early@langmail.me', 'Early', '2026-06-12T09:00:00Z', '2026-06-12T10:00:00Z'),
    ]
    const result = await listCalendarEvents(makeDeps(account(), objects), { args: {}, token: 'tok' })

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('2 event(s)')
    expect(txt).toContain('uid: early@langmail.me')
    expect(txt).toContain('uid: later@langmail.me')
    // Sorted ascending: "Early" appears before "Later".
    expect(txt.indexOf('Early')).toBeLessThan(txt.indexOf('Later'))
  })

  test('lists TZID-qualified events with their timezone', async () => {
    const object: CalendarObject = {
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-07-20T10:30:00Z'),
        organizer: 'host@langmail.me',
        start: new Date('2026-07-20T10:00:00Z'),
        timeZone: 'Europe/Berlin',
        title: 'Berlin Lunch',
        uid: 'berlin@langmail.me',
      }),
      url: `${CAL}berlin.ics`,
    }

    const result = await listCalendarEvents(makeDeps(account(), [object]), { args: {}, token: 'tok' })

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('when: 2026-07-20T12:00:00 Europe/Berlin → 2026-07-20T12:30:00 Europe/Berlin')
  })

  test('passes a time range through when both bounds are given', async () => {
    const captured: FetchEventsParams[] = []
    const args: ListCalendarEventsArgs = { end: '2026-06-13T00:00:00Z', start: '2026-06-12T00:00:00Z' }
    await listCalendarEvents(makeDeps(account(), [], captured), { args, token: 'tok' })
    expect(captured[0]?.timeRange).toEqual({ end: '2026-06-13T00:00:00Z', start: '2026-06-12T00:00:00Z' })
  })

  test('omits the time range when neither bound is given', async () => {
    const captured: FetchEventsParams[] = []
    await listCalendarEvents(makeDeps(account(), [], captured), { args: {}, token: 'tok' })
    expect(captured[0]?.timeRange).toBeUndefined()
  })

  test('errors when only one of start/end is provided', async () => {
    const captured: FetchEventsParams[] = []
    const result = await listCalendarEvents(makeDeps(account(), [], captured), {
      args: { start: '2026-06-12T00:00:00Z' },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  })

  test('reports when there are no events', async () => {
    const result = await listCalendarEvents(makeDeps(account(), []), { args: {}, token: 'tok' })
    expect(result.content[0]?.text).toContain('No events found')
  })

  test('errors when the explicit calendarUrl is unknown', async () => {
    const result = await listCalendarEvents(makeDeps(account(), []), {
      args: { calendarUrl: 'https://m/dav/cal/u/ghost/' },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('ghost')
  })
})
