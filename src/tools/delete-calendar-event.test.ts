import { describe, expect, test } from 'bun:test'

import { type DeleteEventParams, type FetchEventParams } from '../caldav/client.ts'
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

interface Captured {
  deleted: DeleteEventParams[]
  fetched: FetchEventParams[]
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
})

const captured = (): Captured => ({ deleted: [], fetched: [] })

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
})
