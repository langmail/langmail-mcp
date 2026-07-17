import { describe, expect, test } from 'bun:test'

import { type FetchEventParams, type UpdateEventParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { type RespondToEventArgs, respondToEvent, respondToEventInput } from './respond-to-event.ts'

const CAL = 'https://m/dav/cal/u/default/'
const UID = 'evt-1@langmail.me'
const ME = 'me@example.com'

const account = (over: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  calendars: [{ displayName: 'Default', url: CAL }],
  defaultCalendarUrl: CAL,
  organizer: ME,
  ...over,
})

const args = (over: Partial<RespondToEventArgs> = {}): RespondToEventArgs => ({
  response: 'accept',
  uid: UID,
  ...over,
})

// A stored invite where our user is an attendee (NEEDS-ACTION), the organizer
// is someone else — the shape respond_to_event acts on.
const storedEvent = (over: Partial<CalendarObject> = {}): CalendarObject => ({
  data: buildInvite({
    attendees: [ME],
    end: new Date('2026-06-12T10:30:00Z'),
    organizer: 'organizer@example.com',
    sequence: 3,
    start: new Date('2026-06-12T10:00:00Z'),
    title: 'Weekly sync',
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

const makeDeps = (acc: DiscoveredAccount, existing: CalendarObject | null, capturedState: Captured) => ({
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

const captured = (): Captured => ({ fetched: [], updated: [] })

describe('respondToEventInput schema', () => {
  test('requires a uid', () => {
    const { uid: _uid, ...rest } = args()
    expect(respondToEventInput.safeParse(rest).success).toBe(false)
  })

  test('rejects an unknown response', () => {
    expect(respondToEventInput.safeParse({ response: 'maybe', uid: UID }).success).toBe(false)
  })

  test('accepts a valid RSVP', () => {
    expect(respondToEventInput.safeParse(args()).success).toBe(true)
  })
})

describe('respondToEvent', () => {
  test('happy path: PUTs the mutated iCal back with the original etag and confirms the title', async () => {
    const cap = captured()
    const result = await respondToEvent(makeDeps(account(), storedEvent(), cap), { args: args(), token: 'tok' })

    expect(cap.fetched[0]).toEqual({ calendarUrl: CAL, token: 'tok', uid: UID })
    expect(cap.updated).toHaveLength(1)
    const put = cap.updated[0]
    expect(put?.url).toBe(`${CAL}${UID}.ics`)
    expect(put?.etag).toBe('"abc"')
    const ical = (put?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('PARTSTAT=ACCEPTED')
    expect(ical).not.toContain('NEEDS-ACTION')
    // A reply must not bump the organizer's SEQUENCE.
    expect(ical).toContain('SEQUENCE:3')

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('RSVP\'d accepted to "Weekly sync".')
  })

  test('maps decline → DECLINED', async () => {
    const cap = captured()
    const result = await respondToEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ response: 'decline' }),
      token: 'tok',
    })
    expect((cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')).toContain('PARTSTAT=DECLINED')
    expect(result.content[0]?.text).toContain('declined')
  })

  test('maps tentative → TENTATIVE and uses "tentatively" in the confirmation', async () => {
    const cap = captured()
    const result = await respondToEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ response: 'tentative' }),
      token: 'tok',
    })
    expect((cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')).toContain('PARTSTAT=TENTATIVE')
    expect(result.content[0]?.text).toContain('tentatively')
  })

  test('errors when the event does not exist, without writing', async () => {
    const cap = captured()
    const result = await respondToEvent(makeDeps(account(), null, cap), { args: args(), token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(UID)
    expect(cap.updated).toHaveLength(0)
  })

  test('errors when the account has no address', async () => {
    const cap = captured()
    const result = await respondToEvent(makeDeps(account({ organizer: null }), storedEvent(), cap), {
      args: args(),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.fetched).toHaveLength(0)
    expect(cap.updated).toHaveLength(0)
  })

  test('errors when the user is not an attendee, without writing', async () => {
    const cap = captured()
    // The stored event's only attendee is someone else.
    const otherEvent = storedEvent({
      data: buildInvite({
        attendees: ['someone-else@example.com'],
        end: new Date('2026-06-12T10:30:00Z'),
        organizer: 'organizer@example.com',
        start: new Date('2026-06-12T10:00:00Z'),
        title: 'Weekly sync',
        uid: UID,
      }),
    })
    const result = await respondToEvent(makeDeps(account(), otherEvent, cap), { args: args(), token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('not an attendee')
    expect(cap.updated).toHaveLength(0)
  })
})
