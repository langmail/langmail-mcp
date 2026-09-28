import { describe, expect, spyOn, test } from 'bun:test'

import { logger } from '@langmail/logger'

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

// A fully specified edit. Most tests now pass far less than this — that is the
// point of the tool — but the whole-event re-specification path still matters.
const args = (over: Partial<UpdateCalendarEventArgs> = {}): UpdateCalendarEventArgs => ({
  attendees: ['guest@example.com'],
  end: '2026-06-12T11:30:00Z',
  start: '2026-06-12T11:00:00Z',
  title: 'Sync (moved)',
  uid: UID,
  ...over,
})

// An existing stored object the agent is editing: 10:00–10:30Z, one attendee.
// SEQUENCE 2 → update bumps to 3.
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
// two of them the account's own addresses, weekly on Tuesdays, with a location
// and a description. The @gmail.com duplicate is what a delta edit drops.
const unvibeStored = (over: Partial<CalendarObject> = {}): CalendarObject => ({
  data: buildInvite({
    attendees: [
      'me@langmail.me',
      'me@gmail.com',
      'avery@example.org',
      'synthetic.guest1@gmail.com',
      'synthetic.guest2@gmail.com',
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

// A recurring series whose 2026-06-23 occurrence was already moved to 11:00–12:00Z
// and renamed — the object carries the master plus one RECURRENCE-ID override.
const OVERRIDDEN_OCCURRENCE = '2026-06-23T10:00:00Z'
const seriesWithOverride = (): CalendarObject => {
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
  // Deliberately distinct from the master on every mergeable field, so a test
  // that merges against it can't pass by accidentally reading the master.
  const override = buildInvite({
    attendees: ['a@x.com', 'c@x.com'],
    description: 'Occurrence agenda',
    end: new Date('2026-06-23T12:00:00Z'),
    location: 'Room 5',
    organizer: 'host@langmail.me',
    recurrenceId: new Date(OVERRIDDEN_OCCURRENCE),
    sequence: 3,
    start: new Date('2026-06-23T11:00:00Z'),
    timeZone: 'UTC',
    title: 'Weekly Sync (moved)',
    uid: UID,
  })
  return storedEvent({ data: `${master}\r\n${override}` })
}

// An all-day (date-only) stored event: nothing to rebuild a timed VEVENT from.
const allDayStored = (): CalendarObject =>
  storedEvent({
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

// A stored event with a non-mailto attendee the parser can't reduce to an email.
const foreignAttendeeStored = (): CalendarObject =>
  storedEvent({
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

  test('accepts a fully specified edit', () => {
    expect(updateCalendarEventInput.safeParse(args()).success).toBe(true)
  })

  test('accepts a reschedule that names only uid and start', () => {
    expect(updateCalendarEventInput.safeParse({ start: '2026-06-12T14:00:00Z', uid: UID }).success).toBe(true)
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

  test('accepts an empty attendees array (uninvite everyone)', () => {
    expect(updateCalendarEventInput.safeParse(args({ attendees: [] })).success).toBe(true)
  })

  test('accepts the recurrence: "none" sentinel', () => {
    expect(updateCalendarEventInput.safeParse({ recurrence: 'none', uid: UID }).success).toBe(true)
  })

  test('accepts empty strings for location and description (clearing them)', () => {
    expect(updateCalendarEventInput.safeParse({ description: '', location: '', uid: UID }).success).toBe(true)
  })

  test('rejects an unknown notify value', () => {
    expect(updateCalendarEventInput.safeParse({ ...args(), notify: 'some' }).success).toBe(false)
  })

  test('rejects a non-email in removedAttendees', () => {
    expect(updateCalendarEventInput.safeParse({ removedAttendees: ['not-an-email'], uid: UID }).success).toBe(false)
  })
})

describe('updateCalendarEvent — partial updates', () => {
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
    const ical = unfold(put?.ical ?? '')
    expect(ical).toContain('METHOD:REQUEST')
    expect(ical).toContain('SEQUENCE:3')
    expect(ical).toContain(`UID:${UID}`)
    expect(ical).toContain('SUMMARY:Sync (moved)')

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('updated')
  })

  // The headline case from the bug report: a reschedule is uid + start + end,
  // and nothing the caller didn't mention changes.
  test('a time-only reschedule keeps the title, attendees and recurrence', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), unvibeStored(), cap), {
      args: { end: '2026-06-16T12:00:00Z', start: '2026-06-16T11:00:00Z', uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART:20260616T110000Z')
    expect(ical).toContain('DTEND:20260616T120000Z')
    expect(ical).toContain('SUMMARY:unvibe meeting')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(ical).toContain('LOCATION:Zoom')
    expect(ical).toContain('DESCRIPTION:Weekly unvibe')
    // All five attendees survive — the silent-drop the report described.
    expect(ical.split('\r\n').filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(5)
  })

  test('moving only the start keeps the stored duration', async () => {
    const cap = captured()
    // Stored event runs 10:00–10:30Z; moving the start four hours later must
    // keep it 30 minutes long rather than stretch it to the old end.
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { start: '2026-06-12T14:00:00Z', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART:20260612T140000Z')
    expect(ical).toContain('DTEND:20260612T143000Z')
  })

  test('changing only the end keeps the stored start', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { end: '2026-06-12T11:00:00Z', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART:20260612T100000Z')
    expect(ical).toContain('DTEND:20260612T110000Z')
  })

  test('a title-only edit keeps the time and the attendees', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { title: 'Sync (renamed)', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('SUMMARY:Sync (renamed)')
    expect(ical).toContain('DTSTART:20260612T100000Z')
    expect(ical).toContain('DTEND:20260612T103000Z')
    expect(ical).toContain('mailto:guest@example.com')
  })

  test('replacing the attendee list alone keeps the stored time and title', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { attendees: ['anna@example.com'], uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('mailto:anna@example.com')
    expect(ical).not.toContain('mailto:guest@example.com')
    expect(ical).toContain('SUMMARY:Sync')
    expect(ical).toContain('DTSTART:20260612T100000Z')
  })

  test('omitting recurrence keeps a series recurring', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { title: 'Weekly Sync (renamed)', uid: UID },
      token: 'tok',
    })
    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('recurrence: "none" collapses a series to a one-off, keeping everything else', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { recurrence: 'none', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).not.toContain('RRULE')
    expect(ical).toContain('SUMMARY:Weekly Sync')
    expect(ical).toContain('DTSTART:20260616T100000Z')
  })

  test('re-rules the whole series when recurrence is given', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ recurrence: 'FREQ=WEEKLY;BYDAY=TH' }),
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH')
    // SEQUENCE still bumps for a recurring edit.
    expect(ical).toContain('SEQUENCE:3')
  })

  test('empty strings clear the location and description', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account({ organizer: 'me@langmail.me' }), unvibeStored(), cap), {
      args: { description: '', location: '', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).not.toContain('LOCATION')
    expect(ical).not.toContain('DESCRIPTION')
    // Nothing else went with them.
    expect(ical).toContain('SUMMARY:unvibe meeting')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('attendees: [] uninvites everyone and notifies nobody new', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { attendees: [], uid: UID },
      token: 'tok',
    })

    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).not.toContain('ATTENDEE')
    // ORGANIZER must survive the uninvite even though no attendee is left.
    // Stalwart's scheduler acts only when the principal is the organizer, so
    // an object naming none gives the RFC 6638 diff nothing to anchor the
    // CANCEL fan-out on — and the result text below promises that fan-out.
    expect(ical).toContain('ORGANIZER')
    expect(ical).toContain('mailto:host@langmail.me')
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('no attendees remain')
  })

  test('rejects a call that changes nothing, before any I/O', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Nothing to update')
    expect(cap.fetched).toHaveLength(0)
    expect(cap.updated).toHaveLength(0)
  })

  test('notify alone is not a change', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { notify: 'none', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.fetched).toHaveLength(0)
  })

  test('uses explicit timeZone as wall-clock authority', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({
        end: '2026-07-20T12:30:00+02:00',
        start: '2026-07-20T12:00:00+02:00',
        timeZone: 'America/New_York',
      }),
      token: 'tok',
    })

    const ical = unfold(cap.updated[0]?.ical ?? '')
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

    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('DTSTART;TZID=Europe/Berlin:20260720T130000')
  })

  test('a preserved zoned start stays in its own zone', async () => {
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
      args: { title: 'Sync (renamed)', uid: UID },
      token: 'tok',
    })

    const ical = unfold(cap.updated[0]?.ical ?? '')
    // 12:00 Berlin (CEST) = 10:00Z, unchanged by a title-only edit.
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260720T120000')
    expect(ical).toContain('DTEND;TZID=Europe/Berlin:20260720T123000')
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

    const ical = unfold(cap.updated[0]?.ical ?? '')
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

    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('ORGANIZER;CN="host@langmail.me":mailto:host@langmail.me')
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

// The guards that used to fire only on an attendee delta now fire on any edit
// that preserves the field they protect, because every edit is now partial.
describe('updateCalendarEvent — safety guards on preserved state', () => {
  test('refuses a partial edit of a series that carries per-occurrence overrides', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), seriesWithOverride(), cap), {
      args: { title: 'Weekly Sync (renamed)', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('individually-customized')
    expect(cap.updated).toHaveLength(0)
  })

  test('refuses an attendee delta on a series that carries per-occurrence overrides', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), seriesWithOverride(), cap), {
      args: { removedAttendees: ['a@x.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  test('allows a whole-event re-specification to replace a series with overrides', async () => {
    const cap = captured()
    // Nothing is silently carried over here — the caller states the event's
    // whole shape — so flattening the overrides is a deliberate choice.
    const result = await updateCalendarEvent(makeDeps(account(), seriesWithOverride(), cap), {
      args: args({ attendees: ['a@x.com'], recurrence: 'FREQ=WEEKLY;BYDAY=TU' }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect((ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(1)
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('refuses to preserve attendees stored in an address format it can’t parse', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), foreignAttendeeStored(), cap), {
      args: { title: 'Renamed', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('address format')
    expect(cap.updated).toHaveLength(0)
  })

  test('accepts an explicit attendee list on an event with unparsable attendees', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), foreignAttendeeStored(), cap), {
      args: { attendees: ['guest@example.com'], uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(cap.updated).toHaveLength(1)
  })

  test('refuses a whole-event edit of a series with a cancelled occurrence', async () => {
    const cap = captured()
    // delete_calendar_event cancels one occurrence with an EXDATE on the master
    // — no second VEVENT — so a rebuild would resurrect it and re-invite
    // everyone to the meeting they were told was off.
    const withExdate = storedEvent({
      data: recurringStored().data.replace('RRULE:', 'EXDATE:20260623T100000Z\r\nRRULE:'),
    })
    const result = await updateCalendarEvent(makeDeps(account(), withExdate, cap), {
      args: { title: 'Weekly Sync (renamed)', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('cancelled occurrence')
    expect(cap.updated).toHaveLength(0)
  })

  test('refuses to move a fixed-weekday series onto a different weekday', async () => {
    const cap = captured()
    // 2026-06-19 is a Friday; the kept rule pins the series to Tuesdays, so
    // RFC 5545 would read the result as "that Friday, plus every Tuesday".
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { start: '2026-06-19T10:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('repeats on fixed weekdays')
    expect(cap.updated).toHaveLength(0)
  })

  test('allows moving a fixed-weekday series when recurrence is re-ruled too', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { recurrence: 'FREQ=WEEKLY;BYDAY=FR', start: '2026-06-19T10:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('RRULE:FREQ=WEEKLY;BYDAY=FR')
  })

  test('allows moving the time of day within the same weekday', async () => {
    const cap = captured()
    // 2026-06-23 is a Tuesday, so the kept BYDAY=TU rule still holds.
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { start: '2026-06-23T14:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  // A DURATION-only event has no DTEND to carry over, so a partial edit still
  // needs both times — unlike an all-day event, which has both as dates.
  test('still refuses a partial edit of a DURATION-only event', async () => {
    const cap = captured()
    const durationOnly = storedEvent({
      data: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        `UID:${UID}`,
        'SUMMARY:Focus',
        'DTSTART:20260616T100000Z',
        'DURATION:PT1H',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    })
    const result = await updateCalendarEvent(makeDeps(account(), durationOnly, cap), {
      args: { title: 'Renamed', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no explicit end time')
    expect(cap.updated).toHaveLength(0)
  })
})

// A preserved time is wall clock in the zone it was *stored* in. An explicit
// `timeZone` governs the caller's own values and the rebuilt event's rendering
// — it must never re-anchor a time the caller didn't pass.
describe('updateCalendarEvent — timeZone never moves a preserved time', () => {
  const berlinStored = (): CalendarObject =>
    storedEvent({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-07-20T09:00:00Z'),
        organizer: 'host@langmail.me',
        sequence: 2,
        start: new Date('2026-07-20T08:00:00Z'),
        timeZone: 'Europe/Berlin',
        title: 'Sync',
        uid: UID,
      }),
    })

  test('a title-only edit with a foreign timeZone keeps the instant', async () => {
    const cap = captured()
    // Stored 10:00–11:00 Berlin = 08:00–09:00Z. Rendering may move to New York,
    // but the instant must not: 08:00Z is 04:00 New York.
    await updateCalendarEvent(makeDeps(account(), berlinStored(), cap), {
      args: { timeZone: 'America/New_York', title: 'Renamed', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260720T040000')
    expect(ical).toContain('DTEND;TZID=America/New_York:20260720T050000')
  })

  test('an attendee delta with a foreign timeZone keeps the instant', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), berlinStored(), cap), {
      args: { addedAttendees: ['anna@example.com'], timeZone: 'UTC', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART:20260720T080000Z')
    expect(ical).toContain('DTEND:20260720T090000Z')
  })

  test('a caller-supplied start is still read in the caller’s timeZone', async () => {
    const cap = captured()
    // The explicit value keeps its own semantics: 14:00 New York = 18:00Z.
    await updateCalendarEvent(makeDeps(account(), berlinStored(), cap), {
      args: { start: '2026-07-20T14:00:00', timeZone: 'America/New_York', uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260720T140000')
    // Duration preserved from the stored hour.
    expect(ical).toContain('DTEND;TZID=America/New_York:20260720T150000')
  })
})

describe('updateCalendarEvent — single occurrence (recurrenceId)', () => {
  const OCCURRENCE = '2026-06-23T10:00:00Z'

  // Uninviting everyone from one occurrence of a series that has attendees
  // leaves that component with none, but the spliced object still carries
  // METHOD:REQUEST from the master. RFC 5546 §3.2.2 requires ORGANIZER in
  // every REQUEST component, and Stalwart enforces it with 412
  // SameOrganizerInAllComponents — so the override must keep the master's
  // ORGANIZER rather than infer it away from the empty attendee list.
  test('keeps the master’s ORGANIZER on an override left with no attendees', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { attendees: [], recurrenceId: OCCURRENCE, uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect((ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
    expect(ical).toContain('METHOD:REQUEST')
    // One ORGANIZER per component, and both name the same address.
    const organizers = ical.match(/^ORGANIZER.*$/gmu) ?? []
    expect(organizers).toHaveLength(2)
    expect(new Set(organizers).size).toBe(1)
  })

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
    const ical = unfold(put?.ical ?? '')
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

  test('moves one occurrence with uid, recurrenceId, start and end only', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { end: '2026-06-23T12:00:00Z', recurrenceId: OCCURRENCE, start: '2026-06-23T11:00:00Z', uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(ical).toContain('DTSTART:20260623T110000Z')
    expect(ical).toContain('DTEND:20260623T120000Z')
    // The omitted title comes from the series, not from nowhere.
    expect(ical).toContain('SUMMARY:Weekly Sync')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('an occurrence edit that omits the time keeps that occurrence’s own slot', async () => {
    const cap = captured()
    // Not the master's 2026-06-16 slot: the occurrence runs at the instant
    // recurrenceId names, for the series' duration.
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { recurrenceId: OCCURRENCE, title: 'Q3 planning', uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('DTSTART:20260623T100000Z')
    expect(ical).toContain('DTEND:20260623T103000Z')
    expect(ical).toContain('SUMMARY:Q3 planning')
  })

  test('re-editing a customized occurrence merges against that occurrence, not the master', async () => {
    const cap = captured()
    // The occurrence was already moved to 11:00–12:00Z. Renaming it must not
    // silently drag it back to the master's 10:00 slot.
    const result = await updateCalendarEvent(makeDeps(account(), seriesWithOverride(), cap), {
      args: { recurrenceId: OVERRIDDEN_OCCURRENCE, title: 'Renamed again', uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(ical).toContain('DTSTART:20260623T110000Z')
    expect(ical).toContain('DTEND:20260623T120000Z')
    expect(ical).toContain('SUMMARY:Renamed again')
    expect(ical).not.toContain('SUMMARY:Weekly Sync (moved)')
    // Every other mergeable field comes from the override, not the master.
    expect(ical).toContain('LOCATION:Room 5')
    expect(ical).toContain('DESCRIPTION:Occurrence agenda')
    expect(ical).toContain('mailto:c@x.com')
    // Still master + exactly one override for the instant.
    expect((ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
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

    const ical = unfold(cap.updated[0]?.ical ?? '')
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
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260623T100000')
    expect(ical).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260623T100000')
    expect((ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
  })

  test('re-editing an override written in another zone keeps that override’s instant', async () => {
    const cap = captured()
    // Call 1 moved the occurrence with an explicit America/New_York, so the
    // override carries a TZID the master doesn't. Call 2 renames it: reading
    // the override's wall clock in the *master's* Berlin zone would move it.
    const master = buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-16T08:30:00Z'),
      organizer: 'host@langmail.me',
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      sequence: 2,
      start: new Date('2026-06-16T08:00:00Z'),
      timeZone: 'Europe/Berlin',
      title: 'Weekly Sync',
      uid: UID,
    })
    const override = buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-23T14:00:00Z'),
      organizer: 'host@langmail.me',
      recurrenceTimeZone: 'Europe/Berlin',
      recurrenceId: new Date('2026-06-23T08:00:00Z'),
      sequence: 3,
      start: new Date('2026-06-23T13:00:00Z'),
      timeZone: 'America/New_York',
      title: 'Weekly Sync (moved)',
      uid: UID,
    })
    const result = await updateCalendarEvent(
      makeDeps(account(), { data: `${master}\r\n${override}`, etag: '"abc"', url: `${CAL}${UID}.ics` }, cap),
      { args: { recurrenceId: '2026-06-23T08:00:00Z', title: 'Renamed', uid: UID }, token: 'tok' }
    )

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    // 13:00Z, unchanged — rendered in the master's Berlin zone as 15:00.
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260623T150000')
    expect(ical).toContain('DTEND;TZID=Europe/Berlin:20260623T160000')
    expect(ical).toContain('SUMMARY:Renamed')
  })

  test('a zoned occurrence edit that omits the time keeps the occurrence’s wall-clock slot', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), berlinRecurring(), cap), {
      args: { recurrenceId: '2026-06-23T08:00:00Z', title: 'Q3 planning', uid: UID },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    // 10:00–10:30 Berlin, the same wall clock as every other occurrence.
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260623T100000')
    expect(ical).toContain('DTEND;TZID=Europe/Berlin:20260623T103000')
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
    expect(ical).toContain('mailto:avery@example.org')
    expect(ical).toContain('mailto:synthetic.guest1@gmail.com')
    expect(ical).toContain('mailto:synthetic.guest2@gmail.com')
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
    expect(ical).toContain('mailto:avery@example.org')
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  })

  test('adds the first attendee onto an event created without any', async () => {
    // The two-step blocker flow: create_calendar_event without attendees, then
    // invite once the address is known.
    //
    // The stored object deliberately carries no ORGANIZER, because that is
    // what create_calendar_event now writes for a personal event. Promoting it
    // to a scheduling object therefore has no stored organizer to reuse and
    // must fall back to the discovered principal — without one, Stalwart has
    // nothing to fan the invitation out from.
    const cap = captured()
    const personal = storedEvent({
      data: buildInvite({
        attendees: [],
        end: new Date('2026-08-03T13:00:00Z'),
        sequence: 0,
        start: new Date('2026-08-03T12:00:00Z'),
        timeZone: 'UTC',
        title: 'Lunch',
        uid: UID,
      }),
    })
    expect(personal.data).not.toContain('ORGANIZER')

    const result = await updateCalendarEvent(makeDeps(account(), personal, cap), {
      args: { addedAttendees: ['anna@example.com'], uid: UID },
      token: 'tok',
    })
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('mailto:anna@example.com')
    expect(ical).toContain('METHOD:REQUEST')
    expect(ical).toContain('ORGANIZER')
    expect(ical).toContain('mailto:host@langmail.me')
    expect(result.isError).toBeUndefined()
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

  test('rejects combining a delta with an explicit attendees list', async () => {
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
})

describe('updateCalendarEvent — notify', () => {
  test('notify: none suppresses scheduling and says so', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: args({ notify: 'none' }),
      token: 'tok',
    })
    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('SCHEDULE-AGENT=NONE')
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

  // SCHEDULE-AGENT=NONE is only stamped on the attendees that remain, so anyone
  // dropped is cancelled regardless of `notify` — however they were dropped.
  test('notify: none does not claim silence when a replacement list drops someone', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account({ organizer: 'me@langmail.me' }), unvibeStored(), cap), {
      args: { attendees: ['me@langmail.me', 'avery@example.org'], notify: 'none', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('may still receive a cancellation')
  })

  test('notify: none claims silence when a replacement list drops nobody', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { attendees: ['guest@example.com', 'anna@example.com'], notify: 'none', uid: UID },
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('no notifications sent')
    expect(result.content[0]?.text).not.toContain('cancellation')
  })

  test('a re-cased attendee is not mistaken for a removal', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { attendees: ['GUEST@Example.com'], notify: 'none', uid: UID },
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('no notifications sent')
    expect(result.content[0]?.text).not.toContain('cancellation')
  })

  test('an occurrence edit that drops an attendee does not claim silence either', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: {
        attendees: ['someone@example.com'],
        notify: 'none',
        recurrenceId: '2026-06-23T10:00:00Z',
        uid: UID,
      },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('may still receive a cancellation')
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

// The handover line is the outbound-scheduling audit trail (see the
// 2026-07-28-single-occurrence-imip proposal): it must appear exactly once per
// accepted PUT, never for a rejected one, and never carry a raw address.
describe('scheduling handover audit log', () => {
  test('logs one handover line, with hashed identifiers, after a successful occurrence PUT', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const cap = captured()
      const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
        args: args({
          end: '2026-06-23T12:30:00Z',
          recurrenceId: '2026-06-23T10:00:00Z',
          start: '2026-06-23T12:00:00Z',
        }),
        token: 'tok',
      })
      expect(result.isError).toBeUndefined()
      expect(info).toHaveBeenCalledTimes(1)
      const fields = info.mock.calls[0]?.[0] as Record<string, unknown>
      expect(fields.recurrenceId).toBe('2026-06-23T10:00:00Z')
      expect(fields.sequence).toBe(3)
      expect(fields.uidHash).toBe('17809b5be7d6')
      // REVIEW.md: no email addresses in logs — only 12-hex hashes appear.
      expect(JSON.stringify(fields)).not.toContain('guest@example.com')
      expect(JSON.stringify(fields)).not.toContain(UID)
      expect(fields.attendeeHashes).toEqual(['513935c4d2db'])
      expect(fields.removedAttendeeHashes).toEqual([])
    } finally {
      info.mockRestore()
    }
  })

  test('logs current and removed attendee hashes after a successful whole-event PUT', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const cap = captured()
      const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
        args: args({ attendees: ['someone@example.com'] }),
        token: 'tok',
      })
      expect(result.isError).toBeUndefined()
      expect(info).toHaveBeenCalledTimes(1)
      const fields = info.mock.calls[0]?.[0] as Record<string, unknown>
      expect(fields.recurrenceId).toBeUndefined()
      expect(fields.sequence).toBe(3)
      expect(fields.uidHash).toBe('17809b5be7d6')
      expect(fields.attendeeHashes).toEqual(['72497f475e4f'])
      expect(fields.removedAttendeeHashes).toEqual(['513935c4d2db'])
      expect(JSON.stringify(fields)).not.toContain('someone@example.com')
      expect(JSON.stringify(fields)).not.toContain('guest@example.com')
      expect(JSON.stringify(fields)).not.toContain(UID)
    } finally {
      info.mockRestore()
    }
  })

  test('logs nothing when a whole-event PUT is rejected', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const cap = captured()
      const deps = {
        ...makeDeps(account(), storedEvent(), cap),
        updateEvent: () => Promise.reject(new Error('412 precondition failed')),
      }
      await expect(updateCalendarEvent(deps, { args: args(), token: 'tok' })).rejects.toThrow('412 precondition failed')
      expect(info).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })

  test('logs nothing when an occurrence PUT is rejected', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const cap = captured()
      const deps = {
        ...makeDeps(account(), recurringStored(), cap),
        updateEvent: () => Promise.reject(new Error('412 precondition failed')),
      }
      await expect(
        updateCalendarEvent(deps, {
          args: args({ recurrenceId: '2026-06-23T10:00:00Z' }),
          token: 'tok',
        })
      ).rejects.toThrow('412 precondition failed')
      expect(info).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })
})

// A timed event carrying two reminders written by another client: a display
// alarm 15 minutes before and an absolute-trigger email alarm. A rebuild must
// carry both across verbatim — they are never re-serialized from parsed fields.
const ALARM_DISPLAY = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Sync', 'END:VALARM']
const ALARM_EMAIL = [
  'BEGIN:VALARM',
  'ACTION:EMAIL',
  'TRIGGER;VALUE=DATE-TIME:20260612T080000Z',
  'SUMMARY:Heads-up',
  'DESCRIPTION:Sync starts soon',
  'ATTENDEE:mailto:host@example.com',
  'END:VALARM',
]
const withAlarms = (ical: string, ...alarms: string[][]): string =>
  ical.replace('END:VEVENT', () => `${alarms.map((a) => a.join('\r\n')).join('\r\n')}\r\nEND:VEVENT`)

const VALARM_BLOCK_RE = /BEGIN:VALARM[\s\S]*?END:VALARM\r\n/gu
const TRAILING_NEWLINE_RE = /\r?\n?$/u

const valarmBlocks = (ical: string): string[] => unfold(ical).match(/BEGIN:VALARM[\s\S]*?END:VALARM/gu) ?? []

describe('updateCalendarEvent — alarms are preserved', () => {
  test('a title-only edit keeps every stored VALARM', async () => {
    const cap = captured()
    const stored = storedEvent({ data: withAlarms(storedEvent().data, ALARM_DISPLAY, ALARM_EMAIL) })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { title: 'Sync (renamed)', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const alarms = valarmBlocks(cap.updated[0]?.ical ?? '')
    expect(alarms).toEqual([ALARM_DISPLAY.join('\r\n'), ALARM_EMAIL.join('\r\n')])
  })

  test('dollar sequences in a stored alarm are copied literally, not expanded', async () => {
    const cap = captured()
    const dollars = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', "DESCRIPTION:Rent $' $& $$ due", 'END:VALARM']
    const stored = storedEvent({ data: withAlarms(storedEvent().data, dollars) })
    await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { title: 'Sync (renamed)', uid: UID },
      token: 'tok',
    })
    expect(valarmBlocks(cap.updated[0]?.ical ?? '')).toEqual([dollars.join('\r\n')])
  })

  test('a reschedule keeps the stored VALARM', async () => {
    const cap = captured()
    const stored = storedEvent({ data: withAlarms(storedEvent().data, ALARM_DISPLAY) })
    await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { start: '2026-06-12T14:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(valarmBlocks(cap.updated[0]?.ical ?? '')).toEqual([ALARM_DISPLAY.join('\r\n')])
  })

  test('a lowercase VALARM’s ATTENDEE does not make a personal series a scheduling object', async () => {
    const cap = captured()
    const personal = buildInvite({
      attendees: [],
      end: new Date('2026-06-16T10:30:00Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      start: new Date('2026-06-16T10:00:00Z'),
      timeZone: 'UTC',
      title: 'Focus',
      uid: UID,
    })
    const lowerEmail = ALARM_EMAIL.map((l) => (l.startsWith('BEGIN:') || l.startsWith('END:') ? l.toLowerCase() : l))
    const stored = recurringStored({ data: withAlarms(personal, lowerEmail) })
    await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', title: 'Focus (moved)', uid: UID },
      token: 'tok',
    })
    expect(cap.updated[0]?.ical).not.toContain('METHOD:')
  })

  test('an EMAIL alarm’s ATTENDEE does not make a personal series a scheduling object', async () => {
    const cap = captured()
    const personal = buildInvite({
      attendees: [],
      end: new Date('2026-06-16T10:30:00Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      start: new Date('2026-06-16T10:00:00Z'),
      timeZone: 'UTC',
      title: 'Focus',
      uid: UID,
    })
    const stored = recurringStored({ data: withAlarms(personal, ALARM_EMAIL) })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', title: 'Focus (moved)', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(cap.updated[0]?.ical).not.toContain('METHOD:')
  })

  test('an occurrence edit inherits the master’s VALARM', async () => {
    const cap = captured()
    const stored = recurringStored({ data: withAlarms(recurringStored().data, ALARM_DISPLAY) })
    await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', title: 'Moved sync', uid: UID },
      token: 'tok',
    })
    // One on the untouched master, one copied onto the new override.
    expect(valarmBlocks(cap.updated[0]?.ical ?? '')).toEqual([ALARM_DISPLAY.join('\r\n'), ALARM_DISPLAY.join('\r\n')])
  })
})

// A three-day, attendee-less vacation stored as DATE values (DTEND exclusive).
const vacationStored = (): CalendarObject =>
  storedEvent({
    data: [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      `UID:${UID}`,
      'SUMMARY:Vacation',
      'DTSTART;VALUE=DATE:20261003',
      'DTEND;VALUE=DATE:20261006',
      'SEQUENCE:1',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
  })

const DT_LINE_RE = /^(DTSTART|DTEND|RECURRENCE-ID|RRULE)/u
const dtLines = (ical: string): string[] =>
  unfold(ical)
    .split('\r\n')
    .filter((l) => DT_LINE_RE.test(l))

describe('updateCalendarEvent — all-day events', () => {
  test('the schema accepts date-only start, end and recurrenceId', () => {
    expect(
      updateCalendarEventInput.safeParse({
        end: '2026-10-04',
        recurrenceId: '2026-10-03',
        start: '2026-10-03',
        uid: UID,
      }).success
    ).toBe(true)
  })

  test('a rename keeps an all-day series all-day, with its rule and attendees', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), allDayStored(), cap), {
      args: { title: 'Renamed', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = cap.updated[0]?.ical ?? ''
    expect(dtLines(ical)).toEqual([
      'DTSTART;VALUE=DATE:20260616',
      'DTEND;VALUE=DATE:20260617',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
    ])
    expect(unfold(ical)).toContain('SUMMARY:Renamed')
    expect(unfold(ical)).toContain('mailto:a@x.com')
    expect(unfold(ical)).not.toContain('BEGIN:VTIMEZONE')
  })

  test('a rename ignores a timeZone the caller passes', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { timeZone: 'Pacific/Auckland', title: 'Holiday', uid: UID },
      token: 'tok',
    })
    expect(dtLines(cap.updated[0]?.ical ?? '')).toEqual(['DTSTART;VALUE=DATE:20261003', 'DTEND;VALUE=DATE:20261006'])
  })

  test('moving only the start date keeps the length in days', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { start: '2026-10-10', uid: UID },
      token: 'tok',
    })
    expect(dtLines(cap.updated[0]?.ical ?? '')).toEqual(['DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261013'])
  })

  test('changing only the end date extends it and keeps the start', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { end: '2026-10-11', uid: UID },
      token: 'tok',
    })
    expect(dtLines(cap.updated[0]?.ical ?? '')).toEqual(['DTSTART;VALUE=DATE:20261003', 'DTEND;VALUE=DATE:20261011'])
  })

  test('turns an all-day event into a timed one with start and end', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { end: '2026-10-03T12:00:00Z', start: '2026-10-03T09:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(dtLines(cap.updated[0]?.ical ?? '')).toEqual(['DTSTART:20261003T090000Z', 'DTEND:20261003T120000Z'])
  })

  test('turns a timed event into an all-day one with start and end dates', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), storedEvent(), cap), {
      args: { end: '2026-06-13', start: '2026-06-12', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = cap.updated[0]?.ical ?? ''
    expect(dtLines(ical)).toEqual(['DTSTART;VALUE=DATE:20260612', 'DTEND;VALUE=DATE:20260613'])
    // Everything else survives the switch.
    expect(unfold(ical)).toContain('SUMMARY:Sync')
    expect(unfold(ical)).toContain('mailto:guest@example.com')
  })

  test('switching between all-day and timed with only one side is refused', async () => {
    for (const [stored, start] of [
      [vacationStored(), '2026-10-03T09:00:00Z'],
      [storedEvent(), '2026-06-12'],
    ] as const) {
      const cap = captured()
      const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
        args: { start, uid: UID },
        token: 'tok',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('pass both `start` and `end`')
      expect(cap.updated).toHaveLength(0)
    }
  })

  test('a date start with a date-time end is refused', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { end: '2026-10-03T18:00:00Z', start: '2026-10-03', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  test('an all-day end on its start day is refused, naming the exclusive end', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { end: '2026-10-03', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('2026-10-04')
    expect(cap.updated).toHaveLength(0)
  })

  test('switching an all-day series to timed re-types its date UNTIL', async () => {
    const cap = captured()
    const bounded = storedEvent({
      data: allDayStored().data.replace('RRULE:FREQ=WEEKLY;BYDAY=TU', 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229'),
    })
    const result = await updateCalendarEvent(makeDeps(account(), bounded, cap), {
      args: { end: '2026-06-16T10:30:00Z', start: '2026-06-16T10:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T235959Z')
  })

  test('re-ruling an all-day series writes a DATE UNTIL', async () => {
    const cap = captured()
    await updateCalendarEvent(makeDeps(account(), allDayStored(), cap), {
      args: { recurrence: { byDay: ['TU'], frequency: 'weekly', until: '2026-12-29T00:00:00Z' }, uid: UID },
      token: 'tok',
    })
    expect(unfold(cap.updated[0]?.ical ?? '')).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229')
  })

  test('edits one occurrence of an all-day series with a date recurrenceId', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), allDayStored(), cap), {
      args: { recurrenceId: '2026-06-23', title: 'Offsite', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(dtLines(cap.updated[0]?.ical ?? '')).toEqual([
      'DTSTART;VALUE=DATE:20260616',
      'DTEND;VALUE=DATE:20260617',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'DTSTART;VALUE=DATE:20260623',
      'DTEND;VALUE=DATE:20260624',
      'RECURRENCE-ID;VALUE=DATE:20260623',
    ])
  })

  test('an occurrence of an all-day series made timed keeps a DATE RECURRENCE-ID', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), allDayStored(), cap), {
      args: { end: '2026-06-23T12:00:00Z', recurrenceId: '2026-06-23', start: '2026-06-23T09:00:00Z', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(dtLines(cap.updated[0]?.ical ?? '').slice(3)).toEqual([
      'DTSTART:20260623T090000Z',
      'DTEND:20260623T120000Z',
      'RECURRENCE-ID;VALUE=DATE:20260623',
    ])
  })

  test('refuses a date-time recurrenceId on an all-day series instead of truncating it', async () => {
    const cap = captured()
    // 00:30 in UTC+2 is still the 23rd in UTC; slicing the string would read the 24th.
    const result = await updateCalendarEvent(makeDeps(account(), allDayStored(), cap), {
      args: { recurrenceId: '2026-06-24T00:30:00+02:00', title: 'Offsite', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('occurrence’s date')
    expect(cap.updated).toHaveLength(0)
  })

  test('rejects a date recurrenceId that is not an occurrence of the all-day series', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), allDayStored(), cap), {
      args: { recurrenceId: '2026-06-24', title: 'Offsite', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })
})

describe('updateCalendarEvent — DURATION-only series occurrence', () => {
  // A series stored with DURATION and no DTEND has no occurrence slot to merge
  // against; carrying the master's first DTSTART over would silently stretch
  // the override back to the series' first day.
  test('refuses an occurrence edit that passes only end', async () => {
    const cap = captured()
    const durationSeries = storedEvent({
      data: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        `UID:${UID}`,
        'SUMMARY:Weekly focus',
        'DTSTART;VALUE=DATE:20260601',
        'DURATION:P1D',
        'RRULE:FREQ=WEEKLY',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    })
    const result = await updateCalendarEvent(makeDeps(account(), durationSeries, cap), {
      args: { end: '2026-06-17', recurrenceId: '2026-06-15', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })
})

describe('updateCalendarEvent — reminder', () => {
  test('reminderMinutesBefore replaces every stored alarm with one', async () => {
    const cap = captured()
    const stored = storedEvent({ data: withAlarms(storedEvent().data, ALARM_DISPLAY, ALARM_EMAIL) })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { reminderMinutesBefore: 10, uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const alarms = valarmBlocks(cap.updated[0]?.ical ?? '')
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toContain('TRIGGER:-PT10M')
    expect(alarms[0]).toContain('ACTION:DISPLAY')
    expect(result.content[0]?.text).toContain('reminder 10 minutes before')
  })

  test('reminderMinutesBefore: "none" removes every stored alarm', async () => {
    const cap = captured()
    const stored = storedEvent({ data: withAlarms(storedEvent().data, ALARM_DISPLAY, ALARM_EMAIL) })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { reminderMinutesBefore: 'none', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(valarmBlocks(cap.updated[0]?.ical ?? '')).toEqual([])
    expect(result.content[0]?.text).toContain('reminders removed')
  })

  test('reports an all-day reminder as the clock time it fires', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), vacationStored(), cap), {
      args: { reminderMinutesBefore: 900, uid: UID },
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('reminder 09:00 the day before')
  })

  // A reminder is the organizer's own business: changing it must not rebuild
  // the attendee list (which resets every PARTSTAT to NEEDS-ACTION) or bump
  // SEQUENCE (which re-invites everyone).
  test('a reminder-only edit keeps attendee responses and SEQUENCE', async () => {
    const cap = captured()
    const accepted = storedEvent().data.replace('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=ACCEPTED')
    expect(accepted).toContain('PARTSTAT=ACCEPTED')
    const stored = storedEvent({ data: withAlarms(accepted, ALARM_DISPLAY) })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { reminderMinutesBefore: 10, uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).toContain('PARTSTAT=ACCEPTED')
    expect(ical).toContain('SEQUENCE:2')
    expect(ical).not.toContain('SEQUENCE:3')
    expect(valarmBlocks(ical)).toHaveLength(1)
    expect(valarmBlocks(ical)[0]).toContain('TRIGGER:-PT10M')
    expect(result.content[0]?.text).toContain('no notifications sent')
    // Everything but the alarm is byte-identical to what was stored.
    const withoutAlarms = (text: string): string => text.replace(VALARM_BLOCK_RE, '')
    expect(withoutAlarms(ical)).toBe(withoutAlarms(unfold(stored.data)).replace(TRAILING_NEWLINE_RE, '\r\n'))
  })

  test('a reminder-only edit applies to every VEVENT of a series with overrides', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), seriesWithOverride(), cap), {
      args: { reminderMinutesBefore: 'none', uid: UID },
      token: 'tok',
    })
    // No customized-occurrence refusal: nothing is rebuilt, so nothing is flattened.
    expect(result.isError).toBeUndefined()
    // …but every occurrence's own reminder was replaced, and the result says so.
    expect(result.content[0]?.text).toContain('every occurrence')
    expect(valarmBlocks(cap.updated[0]?.ical ?? '')).toEqual([])
    expect((cap.updated[0]?.ical.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
  })

  test('sets a reminder on one occurrence of a personal series', async () => {
    const cap = captured()
    const personal = recurringStored({
      data: buildInvite({
        attendees: [],
        end: new Date('2026-06-16T10:30:00Z'),
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        start: new Date('2026-06-16T10:00:00Z'),
        timeZone: 'UTC',
        title: 'Focus',
        uid: UID,
      }),
    })
    const result = await updateCalendarEvent(makeDeps(account(), personal, cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', reminderMinutesBefore: 60, uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const alarms = valarmBlocks(cap.updated[0]?.ical ?? '')
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toContain('TRIGGER:-PT1H')
  })

  // An existing override already carries the attendees' responses for that
  // occurrence; a reminder change splices its alarms like the whole-event path.
  test('a reminder-only edit of an overridden occurrence keeps responses and SEQUENCE', async () => {
    const cap = captured()
    const stored = seriesWithOverride()
    const accepted = storedEvent({ data: stored.data.replaceAll('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=ACCEPTED') })
    const result = await updateCalendarEvent(makeDeps(account(), accepted, cap), {
      args: { recurrenceId: OVERRIDDEN_OCCURRENCE, reminderMinutesBefore: 5, uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const ical = unfold(cap.updated[0]?.ical ?? '')
    expect(ical).not.toContain('PARTSTAT=NEEDS-ACTION')
    expect(ical).toContain('SEQUENCE:2')
    expect(ical).toContain('SEQUENCE:3')
    expect(ical).not.toContain('SEQUENCE:4')
    // Only the override got the alarm; the master is untouched.
    const alarms = valarmBlocks(ical)
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toContain('TRIGGER:-PT5M')
    const override = ical.slice(ical.lastIndexOf('BEGIN:VEVENT'))
    expect(override).toContain('RECURRENCE-ID')
    expect(override).toContain('TRIGGER:-PT5M')
  })

  test('an occurrence reminder is reported from the override, not the master', async () => {
    const cap = captured()
    // A timed override (09:00–10:00Z, its own title) of an all-day series.
    const override = buildInvite({
      attendees: ['a@x.com', 'b@x.com'],
      end: new Date('2026-06-23T10:00:00Z'),
      organizer: 'host@langmail.me',
      recurrenceAllDay: true,
      recurrenceId: new Date('2026-06-23T00:00:00Z'),
      sequence: 1,
      start: new Date('2026-06-23T09:00:00Z'),
      timeZone: 'UTC',
      title: 'Offsite (morning only)',
      uid: UID,
    })
    const stored = storedEvent({ data: `${allDayStored().data}\r\n${override}` })
    const result = await updateCalendarEvent(makeDeps(account(), stored, cap), {
      args: { recurrenceId: '2026-06-23', reminderMinutesBefore: 60, uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('"Offsite (morning only)"')
    expect(result.content[0]?.text).toContain('reminder 1 hour before')
  })

  test('refuses a reminder-only edit of an un-overridden occurrence of a series with attendees', async () => {
    const cap = captured()
    const result = await updateCalendarEvent(makeDeps(account(), recurringStored(), cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', reminderMinutesBefore: 60, uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('omit `recurrenceId`')
    expect(cap.updated).toHaveLength(0)
  })
})

describe('updateCalendarEvent — cancelled occurrences', () => {
  test('refuses to edit an occurrence of an all-day series that was cancelled', async () => {
    const cap = captured()
    const cancelled = storedEvent({
      data: allDayStored().data.replace(
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEXDATE;VALUE=DATE:20260623'
      ),
    })
    const result = await updateCalendarEvent(makeDeps(account(), cancelled, cap), {
      args: { recurrenceId: '2026-06-23', title: 'Back on', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('cancelled')
    expect(cap.updated).toHaveLength(0)
  })

  test('refuses to edit an occurrence cancelled by a TZID-qualified EXDATE', async () => {
    const cap = captured()
    // A foreign client's form: 12:00 Berlin (CEST) is the 10:00Z occurrence.
    const cancelled = recurringStored({
      data: recurringStored().data.replace(
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEXDATE;TZID=Europe/Berlin:20260623T120000'
      ),
    })
    const result = await updateCalendarEvent(makeDeps(account(), cancelled, cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', title: 'Back on', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })

  test('refuses to edit a cancelled occurrence of a timed series', async () => {
    const cap = captured()
    const cancelled = recurringStored({
      data: recurringStored().data.replace(
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEXDATE:20260623T100000Z'
      ),
    })
    const result = await updateCalendarEvent(makeDeps(account(), cancelled, cap), {
      args: { recurrenceId: '2026-06-23T10:00:00Z', title: 'Back on', uid: UID },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(cap.updated).toHaveLength(0)
  })
})
