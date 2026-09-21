import { describe, expect, test } from 'bun:test'

import { type PutEventParams } from '../caldav/client.ts'
import { type DiscoveredAccount } from '../caldav/types.ts'
import {
  type CreateCalendarEventArgs,
  createCalendarEvent,
  createCalendarEventInput,
  eventUidSchema,
} from './create-calendar-event.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const UID_LINE_RE = /^UID:(.+)$/mu
const FOLD_RE = /\r\n /gu

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
  resolveTimeZone: () => Promise.resolve(null),
  putEvent: (p: PutEventParams) => {
    captured.push(p)
    return Promise.resolve()
  },
})

describe('createCalendarEventInput schema', () => {
  test('accepts a missing attendees field (personal event)', () => {
    const { attendees: _attendees, ...rest } = args()
    expect(createCalendarEventInput.safeParse(rest).success).toBe(true)
  })

  test('accepts an empty attendees array (personal event)', () => {
    expect(createCalendarEventInput.safeParse({ ...args(), attendees: [] }).success).toBe(true)
  })

  test('accepts notify: none', () => {
    expect(createCalendarEventInput.safeParse({ ...args(), notify: 'none' }).success).toBe(true)
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

  test('accepts naive datetimes and an optional IANA timezone', () => {
    expect(
      createCalendarEventInput.safeParse(
        args({ end: '2026-07-20T12:30:00', start: '2026-07-20T12:00:00', timeZone: 'Europe/Berlin' })
      ).success
    ).toBe(true)
  })

  test('rejects an invalid timezone', () => {
    expect(createCalendarEventInput.safeParse(args({ timeZone: 'Mars/Base' })).success).toBe(false)
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

describe('eventUidSchema', () => {
  test('accepts a bare UUID, the form we now mint', () => {
    expect(eventUidSchema.safeParse(crypto.randomUUID()).success).toBe(true)
  })

  // Events created before the UID became a bare UUID are still stored under —
  // and addressed by — `<uuid>@<domain>`, so update/delete/RSVP must keep
  // accepting it. This is the input contract for live data, not a shim.
  test('accepts the legacy uuid@domain form', () => {
    expect(eventUidSchema.safeParse(`${crypto.randomUUID()}@langmail.me`).success).toBe(true)
  })

  test('rejects path separators', () => {
    expect(eventUidSchema.safeParse('../other/evt').success).toBe(false)
    expect(eventUidSchema.safeParse('a\\b').success).toBe(false)
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

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Sync')
    expect(txt).toContain('guest@example.com')
  })

  test('creates a personal event without attendees and sends no invitations', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), {
      args: args({ attendees: undefined, title: 'Focus block' }),
      token: 'tok',
    })

    expect(captured).toHaveLength(1)
    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).not.toContain('ATTENDEE')
    // RFC 5546 REQUEST needs at least one attendee, so a personal event is a
    // plain calendar object — no scheduling METHOD at all.
    expect(ical).not.toContain('METHOD')
    // ORGANIZER follows METHOD: with nobody to schedule with, the VEVENT is a
    // personal event rather than a scheduling object, so it names no organizer.
    expect(ical).not.toContain('ORGANIZER')

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('no attendees, no invitations sent')
    expect(txt).toContain('uid: ')
  })

  // RFC 7986 §5.3: a UID MUST NOT carry host or domain data. We used to mint
  // `<uuid>@<mail domain>`, which both leaked the domain into every outgoing
  // invitation and — because create named the `.ics` after the UID — put a raw
  // `@` in the resource name, which Apple's clients silently drop.
  describe('event UID', () => {
    const uidOf = (ical: string): string => UID_LINE_RE.exec(ical.replace(FOLD_RE, ''))?.[1]?.trim() ?? ''

    test('is a bare UUID carrying no domain', async () => {
      const captured: PutEventParams[] = []
      await createCalendarEvent(makeDeps(account(), captured), { args: args(), token: 'tok' })

      const uid = uidOf(captured[0]?.ical ?? '')
      expect(uid).toMatch(UUID_RE)
      expect(uid).not.toContain('@')
      expect(uid).not.toContain('langmail.me')
    })

    test('is reported back to the caller verbatim', async () => {
      const captured: PutEventParams[] = []
      const result = await createCalendarEvent(makeDeps(account(), captured), { args: args(), token: 'tok' })

      expect(result.content[0]?.text).toContain(`uid: ${uidOf(captured[0]?.ical ?? '')}`)
    })
  })

  test('treats an empty attendees array like a missing one', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), {
      args: args({ attendees: [] }),
      token: 'tok',
    })

    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).not.toContain('ATTENDEE')
    expect(result.content[0]?.text).toContain('no attendees, no invitations sent')
  })

  test('notify: none keeps the attendees but suppresses the invitations', async () => {
    const captured: PutEventParams[] = []
    const result = await createCalendarEvent(makeDeps(account(), captured), {
      args: args({ notify: 'none' }),
      token: 'tok',
    })

    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('SCHEDULE-AGENT=NONE')
    expect(ical).toContain('guest@example.com')
    expect(result.content[0]?.text).toContain('no invitations sent to the 1 attendee(s)')
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

  test('uses explicit timeZone as wall-clock authority even when offsets are present', async () => {
    const captured: PutEventParams[] = []
    await createCalendarEvent(makeDeps(account(), captured), {
      args: args({
        end: '2026-07-20T12:30:00+02:00',
        start: '2026-07-20T12:00:00+02:00',
        timeZone: 'America/New_York',
      }),
      token: 'tok',
    })

    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('TZID:America/New_York')
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260720T120000')
    expect(ical).toContain('DTEND;TZID=America/New_York:20260720T123000')
  })

  test('interprets naive datetimes in the account timezone fallback', async () => {
    const captured: PutEventParams[] = []
    const deps = {
      ...makeDeps(account(), captured),
      resolveTimeZone: () => Promise.resolve('Europe/Berlin'),
    }
    await createCalendarEvent(deps, {
      args: args({ end: '2026-07-20T12:30:00', start: '2026-07-20T12:00:00' }),
      token: 'tok',
    })

    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('DTSTART;TZID=Europe/Berlin:20260720T120000')
  })

  test('keeps an offset datetime instant when only the account timezone fallback exists', async () => {
    const captured: PutEventParams[] = []
    const deps = {
      ...makeDeps(account(), captured),
      resolveTimeZone: () => Promise.resolve('America/New_York'),
    }
    await createCalendarEvent(deps, {
      args: args({ end: '2026-07-20T12:30:00+02:00', start: '2026-07-20T12:00:00+02:00' }),
      token: 'tok',
    })

    const ical = (captured[0]?.ical ?? '').replace(/\r\n /gu, '')
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260720T060000')
    expect(ical).toContain('DTEND;TZID=America/New_York:20260720T063000')
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

  test('write-through receives the attendees after a successful PUT (the Robin case)', async () => {
    const collected: unknown[] = []
    const deps = {
      ...makeDeps(account()),
      collectAttendees: (writeThrough: unknown) => {
        collected.push(writeThrough)
        return Promise.resolve()
      },
    }
    const result = await createCalendarEvent(deps, {
      args: args({ attendees: ['robin@northwind.example'], title: 'Lunch — Kai & Robin' }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(collected).toHaveLength(1)
    const input = collected[0] as {
      attendees: { email: string }[]
      organizer: string
      selfAddress: string
      uid: string
    }
    expect(input.attendees).toEqual([{ email: 'robin@northwind.example' }])
    expect(input.organizer).toBe('host@langmail.me')
    expect(input.selfAddress).toBe('host@langmail.me')
    expect(input.uid).toMatch(UUID_RE)
  })

  test('no write-through call when the PUT fails', async () => {
    const collected: unknown[] = []
    const deps = {
      ...makeDeps(account()),
      collectAttendees: (writeThrough: unknown) => {
        collected.push(writeThrough)
        return Promise.resolve()
      },
      putEvent: () => Promise.reject(new Error('412')),
    }
    await createCalendarEvent(deps, { args: args(), token: 'tok' }).catch(() => null)
    expect(collected).toHaveLength(0)
  })
})
