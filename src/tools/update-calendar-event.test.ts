import { describe, expect, test } from 'bun:test'

import { type FetchEventParams, type UpdateEventParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import {
  mergeAttendees,
  type UpdateCalendarEventArgs,
  updateCalendarEvent,
  updateCalendarEventInput,
} from './update-calendar-event.ts'

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
    timeZone: 'UTC',
    title: 'Sync',
    uid: UID,
  }),
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
    timeZone: 'UTC',
    title: 'Weekly Sync',
    uid: UID,
  }),
  etag: '"abc"',
  url: `${CAL}${UID}.ics`,
  ...over,
})

// A recurring master mirroring the reported "unvibe meeting": five attendees,
// two of them the account's own addresses, weekly on Tuesdays. The @gmail.com
// duplicate is what a delta edit drops.
const unvibeStored = (over: Partial<CalendarObject> = {}): CalendarObject => ({
  data: buildInvite({
    attendees: [
      'me@langmail.me',
      'me@gmail.com',
      'kai@atelier.example',
      'mika.sandor@example.com',
      'jo.brightwater@example.com',
    ],
    description: 'Weekly unvibe',
    end: new Date('2026-06-16T10:30:00Z'),
    location: 'Zoom',
    organizer: 'me@langmail.me',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    sequence: 2,
    start: new Date('2026-06-16T10:00:00Z'),
    timeZone: 'UTC',
    title: 'unvibe meeting',
    uid: UID,
  }),
  etag: '"abc"',
  url: `${CAL}${UID}.ics`,
  ...over,
})

// Unfolds RFC 5545 line folding so substring assertions don't trip over a
// folded attendee address (mirrors the ical.test.ts helper).
const unfold = (ical: string): string => ical.replace(/\r\n /gu, '')

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
  resolveTimeZone: () => Promise.resolve(null),
  updateEvent: (p: UpdateEventParams) => {
    capturedState.updated.push(p)
    return Promise.resolve()
  },
})

const captured = (): Captured => ({ fetched: [], updated: [] })

// The whole ORGANIZER content line including folded continuations, for
// building a stored object that never carried one.
const ORGANIZER_LINE_RE = /^ORGANIZER[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n/mu

describe('updateCalendarEventInput schema', () => {
  test('requires a uid', () => {
    const { uid: _uid, ...rest } = args()
    expect(updateCalendarEventInput.safeParse(rest).success).toBe(false)
  })

  test('accepts a valid edit', () => {
    expect(updateCalendarEventInput.safeParse(args()).success).toBe(true)
  })

  test('accepts naive start/end with a timezone', () => {
    expect(
      updateCalendarEventInput.safeParse(
        args({ end: '2026-07-20T12:30:00', start: '2026-07-20T12:00:00', timeZone: 'Europe/Berlin' })
      ).success
    ).toBe(true)
  })

  test('accepts an optional recurrenceId', () => {
    expect(updateCalendarEventInput.safeParse(args({ recurrenceId: '2026-06-23T10:00:00Z' })).success).toBe(true)
  })

  test('rejects a recurrenceId without an offset', () => {
    expect(updateCalendarEventInput.safeParse(args({ recurrenceId: '2026-06-23T10:00:00' })).success).toBe(false)
  })

  test('accepts a delta edit that names only the attendees to remove', () => {
    expect(updateCalendarEventInput.safeParse({ removedAttendees: ['x@example.com'], uid: UID }).success).toBe(true)
  })

  test('accepts addedAttendees on their own', () => {
    expect(updateCalendarEventInput.safeParse({ addedAttendees: ['x@example.com'], uid: UID }).success).toBe(true)
  })

  test('accepts notify: none', () => {
    expect(updateCalendarEventInput.safeParse(args({ notify: 'none' })).success).toBe(true)
  })

  test('rejects an unknown notify value', () => {
    expect(updateCalendarEventInput.safeParse({ ...args(), notify: 'some' }).success).toBe(false)
  })

  test('rejects a non-email in removedAttendees', () => {
    expect(updateCalendarEventInput.safeParse({ removedAttendees: ['not-an-email'], uid: UID }).success).toBe(false)
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

  test('uses explicit timeZone as wall-clock authority on full updates', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({
        end: '2026-07-20T12:30:00+02:00',
        start: '2026-07-20T12:00:00+02:00',
        timeZone: 'America/New_York',
      }),
      token: 'tok',
    })

    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260720T120000')
    expect(ical).toContain('DTEND;TZID=America/New_York:20260720T123000')
  })

  test('keeps the stored event timezone when no explicit timezone is passed', async () => {
    const cap = captured()
    const stored = storedEvent({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-07-20T10:30:00Z'),
        organizer: 'host@langmail.me',
        sequence: 2,
        start: new Date('2026-07-20T10:00:00Z'),
        timeZone: 'Europe/Berlin',
        title: 'Sync',
        uid: UID,
      }),
    })
    await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: args({ end: '2026-07-20T13:30:00', start: '2026-07-20T13:00:00' }),
      token: 'tok',
    })

    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260720T130000')
  })

  test('collapses a series to a one-off when recurrence is omitted', async () => {
    const cap = captured()
    // The stored event is genuinely recurring, so this exercises the collapse —
    // not just a fresh non-recurring edit happening to lack an RRULE.
    const recurringEvent = storedEvent({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-12T10:30:00Z'),
        organizer: 'host@langmail.me',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        sequence: 2,
        start: new Date('2026-06-12T10:00:00Z'),
        timeZone: 'UTC',
        title: 'Sync',
        uid: UID,
      }),
    })
    await updateCalendarEvent(makeDeps(account(), recurringEvent, cap), { args: args(), token: 'tok' })
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

  test('reuses the stored ORGANIZER when it differs from the discovered principal', async () => {
    const cap = captured()
    // The event was created under a previous account address (still an enabled
    // alias). Discovery now returns the new primary; rebuilding the invite with
    // it would make Stalwart reject any later occurrence edit with 412
    // SameOrganizerInAllComponents — the stored organizer must win.
    const stored = storedEvent({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-12T10:30:00Z'),
        organizer: 'old-alias@langmail.me',
        sequence: 2,
        start: new Date('2026-06-12T10:00:00Z'),
        timeZone: 'UTC',
        title: 'Sync',
        uid: UID,
      }),
    })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), { args: args(), token: 'tok' })

    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('ORGANIZER;CN="old-alias@langmail.me":mailto:old-alias@langmail.me')
    expect(ical).not.toContain('mailto:host@langmail.me')
    expect(result.isError).toBeUndefined()
  })

  test('falls back to the discovered organizer when the stored object has none', async () => {
    const cap = captured()
    const stored = storedEvent({
      data: storedEvent().data.replace(ORGANIZER_LINE_RE, ''),
    })
    expect(stored.data).not.toContain('ORGANIZER')
    await updateCalendarEvent(makeDeps(account(), stored, cap), { args: args(), token: 'tok' })

    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('ORGANIZER;CN="host@langmail.me":mailto:host@langmail.me')
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

describe('updateCalendarEvent — single occurrence (recurrenceId)', () => {
  const OCCURRENCE = '2026-06-23T10:00:00Z'

  test('splices an override alongside the untouched master', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ recurrenceId: OCCURRENCE, title: 'Weekly Sync — Q3 planning' }),
      token: 'tok',
    })

    expect(cap.updated).toHaveLength(1)
    const put = cap.updated[0]
    expect(put?.url).toBe(`${CAL}${UID}.ics`)
    expect(put?.etag).toBe('"abc"')
    const ical = (put?.ical ?? '').replace(/\r\n /gu, '')
    // Master RRULE survives; the override targets just the one instance.
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(ical).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(ical).toContain('SUMMARY:Weekly Sync — Q3 planning')
    expect((ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
    // Fresh override bumps past the master's SEQUENCE 2.
    expect(ical).toContain('SEQUENCE:3')

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Occurrence')
    expect(result.content[0]?.text).toContain(OCCURRENCE)
  })

  test('override reuses the stored master ORGANIZER, not the discovered principal', async () => {
    const cap = captured()
    const stored = recurringStored({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-16T10:30:00Z'),
        organizer: 'old-alias@langmail.me',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        sequence: 2,
        start: new Date('2026-06-16T10:00:00Z'),
        timeZone: 'UTC',
        title: 'Weekly Sync',
        uid: UID,
      }),
    })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })

    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    // Master and override must agree on ORGANIZER or Stalwart rejects the PUT
    // with 412 SameOrganizerInAllComponents.
    expect(ical).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(ical).not.toContain('mailto:host@langmail.me')
    expect(ical.match(/ORGANIZER;CN="old-alias@langmail\.me":mailto:old-alias@langmail\.me/gu)).toHaveLength(2)
    expect(result.isError).toBeUndefined()
  })

  test('rejects a recurrenceId that is not an occurrence of the series', async () => {
    const cap = captured()
    // 2026-06-24 is a Wednesday — not on the Tuesday rule.
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ recurrenceId: '2026-06-24T10:00:00Z' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('occurrence')
    expect(cap.updated).toHaveLength(0)
  })

  test('rejects cleanly when the master rule cannot be parsed', async () => {
    const cap = captured()
    // A trailing `;` passes create's light RRULE validation and is stored, but
    // the rrule engine throws on it — the tool must surface a clear error, not
    // an opaque crash, and must not write an unvalidated override.
    const brokenRule = recurringStored({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-16T10:30:00Z'),
        organizer: 'host@langmail.me',
        rrule: 'FREQ=WEEKLY;BYDAY=TU;',
        sequence: 2,
        start: new Date('2026-06-16T10:00:00Z'),
        timeZone: 'UTC',
        title: 'Weekly Sync',
        uid: UID,
      }),
    })
    const result = await updateCalendarEvent(makeDeps(account(), brokenRule, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Could not evaluate')
    expect(cap.updated).toHaveLength(0)
  })

  test('rejects editing an occurrence of a non-recurring event', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('not a recurring series')
    expect(cap.updated).toHaveLength(0)
  })

  test('rejects combining recurrence and recurrenceId (before any I/O)', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ recurrence: 'FREQ=WEEKLY;BYDAY=TU', recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.fetched).toHaveLength(0)
    expect(cap.updated).toHaveLength(0)
  })

  test('errors when the recurring event does not exist', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), null, cap), {
      args: args({ recurrenceId: OCCURRENCE }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  // A recurring master stored in Europe/Berlin: Tuesdays 10:00 Berlin from
  // 2026-06-16 (08:00Z in summer). Membership is validated against the master's
  // own zone (startTzid), and the override's RECURRENCE-ID keeps that zone.
  const berlinRecurring = (): CalendarObject => ({
    data: buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-16T08:30:00Z'),
      organizer: 'host@langmail.me',
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      sequence: 2,
      start: new Date('2026-06-16T08:00:00Z'),
      timeZone: 'Europe/Berlin',
      title: 'Weekly Sync',
      uid: UID,
    }),
    etag: '"abc"',
    url: `${CAL}${UID}.ics`,
  })

  test('edits a zoned occurrence, keeping the master TZID on the RECURRENCE-ID', async () => {
    const cap = captured()
    // The occurrence's original start is 10:00 Berlin (CEST) = 08:00Z; naive
    // start/end are read in the stored event's own zone (Europe/Berlin).
    const result = await updateCalendarEvent(makeDeps(account(), berlinRecurring(), cap), {
      args: args({
        end: '2026-06-23T11:00:00',
        recurrenceId: '2026-06-23T08:00:00Z',
        start: '2026-06-23T10:00:00',
        title: 'Weekly Sync — Q3 planning',
      }),
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = (cap.updated[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260623T100000')
    expect(ical).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260623T100000')
    expect((ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
  })
})

describe('mergeAttendees', () => {
  test('drops a removed address and keeps the rest in order', () => {
    expect(mergeAttendees(['a@x.com', 'b@x.com', 'c@x.com'], [], ['b@x.com'])).toEqual(['a@x.com', 'c@x.com'])
  })

  test('appends added addresses after the stored ones', () => {
    expect(mergeAttendees(['a@x.com'], ['b@x.com'], [])).toEqual(['a@x.com', 'b@x.com'])
  })

  test('matches removals case-insensitively', () => {
    expect(mergeAttendees(['Me@Gmail.com'], [], ['me@gmail.com'])).toEqual([])
  })

  test('is a no-op when removing an absent address or adding a present one', () => {
    expect(mergeAttendees(['a@x.com'], ['A@x.com'], ['ghost@x.com'])).toEqual(['a@x.com'])
  })
})

describe('updateCalendarEvent — attendee delta', () => {
  // The acceptance scenario: drop the account's own @gmail.com duplicate from a
  // recurring meeting, re-passing nothing else.
  test('removes one attendee while preserving the recurrence and every other field', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account({ organizer: 'me@langmail.me' }), unvibeStored(), cap), {
      args: { removedAttendees: ['me@gmail.com'], uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    // The four intended attendees survive; the gmail duplicate is gone.
    expect(ical).toContain('mailto:me@langmail.me')
    expect(ical).toContain('mailto:kai@atelier.example')
    expect(ical).toContain('mailto:mika.sandor@example.com')
    expect(ical).toContain('mailto:jo.brightwater@example.com')
    expect(ical).not.toContain('mailto:me@gmail.com')
    // Recurrence, title, time, location, description all preserved — not collapsed
    // or dropped by omission.
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(ical).toContain('SUMMARY:unvibe meeting')
    expect(ical).toContain('DTSTART:20260616T100000Z')
    expect(ical).toContain('LOCATION:Zoom')
    expect(ical).toContain('DESCRIPTION:Weekly unvibe')
    // SEQUENCE still bumps so attendee clients treat it as an update.
    expect(ical).toContain('SEQUENCE:3')
  })

  test('adds an attendee onto the stored list', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account({ organizer: 'me@langmail.me' }), unvibeStored(), cap), {
      args: { addedAttendees: ['newcomer@example.com'], uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('mailto:newcomer@example.com')
    expect(ical).toContain('mailto:kai@atelier.example')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('lets an explicit field override while others are preserved', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account({ organizer: 'me@langmail.me' }), unvibeStored(), cap), {
      args: { removedAttendees: ['me@gmail.com'], title: 'unvibe (renamed)', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('SUMMARY:unvibe (renamed)')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('rejects combining a delta with a full attendees list', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), unvibeStored(), cap), {
      args: { attendees: ['a@x.com'], removedAttendees: ['me@gmail.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  test('rejects combining a delta with recurrenceId', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), unvibeStored(), cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', removedAttendees: ['me@gmail.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('recurrenceId')
    expect(cap.updated).toHaveLength(0)
  })

  test('refuses to remove the last attendee', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { removedAttendees: ['guest@example.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('none')
    expect(cap.updated).toHaveLength(0)
  })

  test('a full update still requires attendees/start/end/title', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { title: 'Only a title', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  // A whole-event rebuild would discard per-occurrence overrides, so a delta
  // refuses rather than silently reverting a customized occurrence.
  test('refuses a delta on a series that carries per-occurrence overrides', async () => {
    const cap = captured()
    const master = buildInvite({
      attendees: ['a@x.com', 'b@x.com'],
      end: new Date('2026-06-16T10:30:00Z'),
      organizer: 'host@langmail.me',
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      sequence: 2,
      start: new Date('2026-06-16T10:00:00Z'),
      timeZone: 'UTC',
      title: 'Weekly Sync',
      uid: UID,
    })
    const override = buildInvite({
      attendees: ['a@x.com', 'b@x.com'],
      end: new Date('2026-06-23T12:00:00Z'),
      organizer: 'host@langmail.me',
      recurrenceId: new Date('2026-06-23T10:00:00Z'),
      sequence: 3,
      start: new Date('2026-06-23T11:00:00Z'),
      timeZone: 'UTC',
      title: 'Weekly Sync (moved)',
      uid: UID,
    })
    const withOverride = storedEvent({ data: `${master}\r\n${override}` })
    const result = await updateCalendarEvent(makeDeps(account(), withOverride, cap), {
      args: { removedAttendees: ['a@x.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('occurrence')
    expect(cap.updated).toHaveLength(0)
  })

  // Non-mailto attendees can't be parsed to an email; a rebuild would drop them,
  // so a delta refuses rather than silently uninviting them.
  test('refuses a delta when a stored attendee can’t be parsed', async () => {
    const cap = captured()
    const foreign = storedEvent({
      data: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        `UID:${UID}`,
        'SUMMARY:Foreign',
        'DTSTART:20260616T100000Z',
        'DTEND:20260616T103000Z',
        'ATTENDEE;CN=Jane;EMAIL=jane@example.com:urn:uuid:1234',
        'ATTENDEE:mailto:guest@example.com',
        'ORGANIZER;CN="host@langmail.me":mailto:host@langmail.me',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    })
    const result = await updateCalendarEvent(makeDeps(account(), foreign, cap), {
      args: { removedAttendees: ['guest@example.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('address format')
    expect(cap.updated).toHaveLength(0)
  })

  // Preserving an all-day (date-only) time would throw when rebuilt as a timed
  // VEVENT, so a delta asks for an explicit start/end instead of crashing.
  test('refuses a delta on an all-day event without an explicit time', async () => {
    const cap = captured()
    const allDay = storedEvent({
      data: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        `UID:${UID}`,
        'SUMMARY:All day',
        'DTSTART;VALUE=DATE:20260616',
        'DTEND;VALUE=DATE:20260617',
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'ATTENDEE:mailto:a@x.com',
        'ATTENDEE:mailto:b@x.com',
        'ORGANIZER;CN="host@langmail.me":mailto:host@langmail.me',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    })
    const result = await updateCalendarEvent(makeDeps(account(), allDay, cap), {
      args: { removedAttendees: ['a@x.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('start')
    expect(cap.updated).toHaveLength(0)
  })
})

describe('updateCalendarEvent — notify', () => {
  test('notify: none suppresses scheduling and says so', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ notify: 'none' }),
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('SCHEDULE-AGENT=NONE')
    expect(result.content[0]?.text).toContain('no notifications sent')
  })

  test('notify defaults to all — no SCHEDULE-AGENT, and the message names the recipients', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args(),
      token: 'tok',
    })
    expect(cap.updated[0]?.ical ?? '').not.toContain('SCHEDULE-AGENT')
    expect(result.content[0]?.text).toContain('notifications sent to')
  })

  test('notify: none combines with a delta to make a quiet one-attendee removal', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account({ organizer: 'me@langmail.me' }), unvibeStored(), cap), {
      args: { notify: 'none', removedAttendees: ['me@gmail.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    // Every remaining attendee is SCHEDULE-AGENT=NONE, so none are re-notified.
    const attendeeLines = ical.split('\r\n').filter((l) => l.startsWith('ATTENDEE'))
    expect(attendeeLines).toHaveLength(4)
    for (const line of attendeeLines) {
      expect(line).toContain('SCHEDULE-AGENT=NONE')
    }
  })

  test('notify: none stamps SCHEDULE-AGENT on an occurrence override too', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: args({ notify: 'none', recurrenceId: '2026-06-23T10:00:00Z' }),
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(ical).toContain('SCHEDULE-AGENT=NONE')
  })
})
