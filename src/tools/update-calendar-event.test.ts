import { describe, expect, test } from 'bun:test'

import { type FetchEventParams, type UpdateEventParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
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

  test('accepts an optional recurrenceId', () => {
    expect(updateCalendarEventInput.safeParse(args({ recurrenceId: '2026-06-23T10:00:00Z' })).success).toBe(true)
  })

  test('rejects a recurrenceId without an offset', () => {
    expect(updateCalendarEventInput.safeParse(args({ recurrenceId: '2026-06-23T10:00:00' })).success).toBe(false)
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
    // The stored event is genuinely recurring, so this exercises the collapse —
    // not just a fresh non-recurring edit happening to lack an RRULE.
    const recurringStored = storedEvent({
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-06-12T10:30:00Z'),
        organizer: 'host@langmail.me',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        sequence: 2,
        start: new Date('2026-06-12T10:00:00Z'),
        title: 'Sync',
        uid: UID,
      }),
    })
    await updateCalendarEvent(makeDeps(account(), recurringStored, cap), { args: args(), token: 'tok' })
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
})
