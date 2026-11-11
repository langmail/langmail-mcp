import { describe, expect, test } from 'bun:test'

import { buildInvite, maxSequence, parseSequence } from './ical.ts'

// RFC 5545 folds long lines at 75 octets with a CRLF + space; undo that
// so substring assertions don't trip over a folded email address.
const unfold = (ics: string): string => ics.replace(/\r\n /gu, '')

const DTSTAMP_LINE_RE = /^DTSTAMP.*$/mu
// RFC 5545 §3.8.7.2: a UTC DATE-TIME — no TZID param, no floating form.
const DTSTAMP_UTC_RE = /^DTSTAMP:\d{8}T\d{6}Z$/u
const DTSTAMP_PARTS_RE = /^DTSTAMP:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u

const baseInput = {
  attendees: ['guest@example.com'],
  end: new Date('2026-06-12T10:30:00Z'),
  organizer: 'host@langmail.me',
  start: new Date('2026-06-12T10:00:00Z'),
  timeZone: 'UTC',
  title: 'Sync',
  uid: 'evt-1@langmail.me',
}

describe('buildInvite', () => {
  test('produces a METHOD:REQUEST VCALENDAR with the organizer and uid', () => {
    const ics = buildInvite(baseInput)
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('UID:evt-1@langmail.me')
    expect(ics).toContain('SUMMARY:Sync')
    expect(ics).toContain('mailto:host@langmail.me')
  })

  test('omits METHOD entirely for an attendee-less (personal) event', () => {
    // RFC 5546 REQUEST requires at least one ATTENDEE, and with nobody to
    // schedule the object should be a plain calendar object (RFC 4791 §4.1).
    const ics = buildInvite({ ...baseInput, attendees: [] })
    expect(ics).not.toContain('METHOD')
    expect(ics).not.toContain('ATTENDEE')
  })

  test('omits ORGANIZER when the caller passes none', () => {
    // RFC 5545 §3.8.4.3 scopes ORGANIZER to a group-scheduled component, so a
    // freshly created personal event may leave it out. That is the caller's
    // decision, expressed by omitting the field.
    const { organizer: _organizer, ...personal } = baseInput
    expect(buildInvite({ ...personal, attendees: [] })).not.toContain('ORGANIZER')
  })

  // Emitting it must not be inferred from the attendee list: an occurrence
  // override of a series that has attendees, and an event everyone has just
  // been uninvited from, both have none and both still require an ORGANIZER.
  test('keeps ORGANIZER on an attendee-less event when the caller passes one', () => {
    const ics = unfold(buildInvite({ ...baseInput, attendees: [] }))
    expect(ics).toContain('ORGANIZER')
    expect(ics).toContain('mailto:host@langmail.me')
  })

  test('keeps ORGANIZER when there are attendees', () => {
    const ics = unfold(buildInvite(baseInput))
    expect(ics).toContain('ORGANIZER')
    expect(ics).toContain('mailto:host@langmail.me')
  })

  // RFC 5545 §3.8.7.2: DTSTAMP is a UTC DATE-TIME. ical-generator formats it in
  // the event's timezone, so a zoned event used to get a floating local
  // timestamp whose meaning depended on the host clock.
  describe('DTSTAMP', () => {
    const dtstampOf = (ics: string): string => DTSTAMP_LINE_RE.exec(unfold(ics))?.[0] ?? ''

    test('is UTC for a UTC event', () => {
      expect(dtstampOf(buildInvite(baseInput))).toMatch(DTSTAMP_UTC_RE)
    })

    test('is UTC for a zoned event, with no TZID param', () => {
      const line = dtstampOf(buildInvite({ ...baseInput, timeZone: 'Europe/Berlin' }))
      expect(line).toMatch(DTSTAMP_UTC_RE)
      expect(line).not.toContain('TZID')
    })

    test('stamps the current instant', () => {
      const before = Date.now()
      const line = dtstampOf(buildInvite({ ...baseInput, timeZone: 'Europe/Berlin' }))
      const [, y, mo, d, h, mi, s] = DTSTAMP_PARTS_RE.exec(line) ?? []
      const stamped = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      // Truncated to whole seconds, so allow the second `before` fell in.
      expect(stamped).toBeGreaterThanOrEqual(before - 1000)
      expect(stamped).toBeLessThanOrEqual(Date.now())
    })
  })

  test('adds each attendee with RSVP and NEEDS-ACTION', () => {
    const ics = unfold(buildInvite({ ...baseInput, attendees: ['a@example.com', 'b@example.com'] }))
    expect(ics).toContain('a@example.com')
    expect(ics).toContain('b@example.com')
    expect(ics).toContain('RSVP=TRUE')
    expect(ics).toContain('PARTSTAT=NEEDS-ACTION')
  })

  test('writes a carried attendee’s reply, CN and ROLE back', () => {
    const ics = unfold(
      buildInvite({
        ...baseInput,
        attendees: [{ email: 'a@example.com', name: 'Robin', role: 'opt-participant', status: 'accepted' }],
      })
    )
    expect(ics).toContain('ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN="Robin":mailto:a@example.com')
  })

  // A CN lengthens the ATTENDEE line until ical-generator's 75-octet fold lands
  // inside the uppercase `:MAILTO:` scheme; it must still come out lowercase.
  test('lowercases the mailto: scheme even when a line fold splits it', () => {
    const raw = buildInvite({
      ...baseInput,
      attendees: [{ email: 'a@example.com', name: 'Robin', status: 'ACCEPTED' }],
    })
    expect(raw).toContain(':mailt\r\n o:')
    expect(unfold(raw)).not.toContain('MAILTO')
  })

  test('falls back to NEEDS-ACTION and REQ-PARTICIPANT for an unknown PARTSTAT or ROLE', () => {
    const ics = unfold(
      buildInvite({ ...baseInput, attendees: [{ email: 'a@example.com', role: 'X-HOST', status: 'X-MAYBE' }] })
    )
    expect(ics).toContain('ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION')
  })

  // ical-generator emits the ATTENDEE CAL-ADDRESS scheme in uppercase
  // (`:MAILTO:`) while the ORGANIZER gets lowercase (`:mailto:`). Stalwart's
  // iMIP scheduler only strips the lowercase prefix to derive the SMTP
  // recipient, so an uppercase scheme leaks into `RCPT TO:<mailto:...>` and
  // the message bounces. Keep every CAL-ADDRESS scheme lowercase.
  test('emits attendee and organizer addresses with a lowercase mailto: scheme', () => {
    const ics = unfold(buildInvite({ ...baseInput, attendees: ['guest@example.com'] }))
    expect(ics).toContain('ATTENDEE')
    expect(ics).not.toContain('MAILTO:')
    expect(ics).toContain('mailto:guest@example.com')
    expect(ics).toContain('mailto:host@langmail.me')
  })

  test('uses CRLF line endings (RFC 5545)', () => {
    const ics = buildInvite(baseInput)
    expect(ics).toContain('\r\n')
  })

  test('omits description/location when not provided', () => {
    const ics = buildInvite(baseInput)
    expect(ics).not.toContain('DESCRIPTION:')
    expect(ics).not.toContain('LOCATION:')
  })

  test('includes description and location when provided', () => {
    const ics = buildInvite({ ...baseInput, description: 'Quarterly review', location: 'Room 4' })
    expect(ics).toContain('DESCRIPTION:Quarterly review')
    expect(ics).toContain('LOCATION:Room 4')
  })

  test('emits the given SEQUENCE when set (for edits)', () => {
    const ics = buildInvite({ ...baseInput, sequence: 3 })
    expect(ics).toContain('SEQUENCE:3')
  })

  describe('showAs', () => {
    const withoutDtstamp = (ics: string): string => ics.replace(DTSTAMP_LINE_RE, '')

    test('free writes TRANSP:TRANSPARENT', () => {
      expect(buildInvite({ ...baseInput, showAs: 'free' })).toContain('\r\nTRANSP:TRANSPARENT\r\n')
    })

    test('busy writes TRANSP:OPAQUE', () => {
      expect(buildInvite({ ...baseInput, showAs: 'busy' })).toContain('\r\nTRANSP:OPAQUE\r\n')
    })

    test('omitted writes no TRANSP, and the output otherwise matches a free one line for line', () => {
      const omitted = buildInvite(baseInput)
      expect(omitted).not.toContain('TRANSP')
      const free = buildInvite({ ...baseInput, showAs: 'free' }).replace('TRANSP:TRANSPARENT\r\n', '')
      expect(withoutDtstamp(free)).toBe(withoutDtstamp(omitted))
    })
  })

  test('omits RRULE for a one-off event', () => {
    expect(buildInvite(baseInput)).not.toContain('RRULE')
  })

  test('emits a single RRULE line when rrule is given', () => {
    const ics = unfold(buildInvite({ ...baseInput, rrule: 'FREQ=WEEKLY;BYDAY=TH' }))
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH')
    // ical-generator owns the `RRULE:` prefix — passing the raw rule must not
    // double it up.
    expect(ics).not.toContain('RRULE:RRULE:')
  })

  test('emits a RECURRENCE-ID line for a single-occurrence override', () => {
    const ics = unfold(buildInvite({ ...baseInput, recurrenceId: new Date('2026-06-12T10:00:00Z') }))
    expect(ics).toContain('RECURRENCE-ID:20260612T100000Z')
  })

  test('emits DTSTART with TZID and a matching VTIMEZONE for non-UTC invites', () => {
    const ics = unfold(
      buildInvite({
        ...baseInput,
        end: new Date('2026-07-20T10:30:00Z'),
        start: new Date('2026-07-20T10:00:00Z'),
        timeZone: 'Europe/Berlin',
      })
    )

    expect(ics).toContain('BEGIN:VTIMEZONE')
    expect(ics).toContain('TZID:Europe/Berlin')
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260720T120000')
    expect(ics).toContain('DTEND;TZID=Europe/Berlin:20260720T123000')
  })

  test('emits RECURRENCE-ID with the event timezone', () => {
    const ics = unfold(
      buildInvite({
        ...baseInput,
        end: new Date('2026-07-27T10:30:00Z'),
        recurrenceId: new Date('2026-07-20T10:00:00Z'),
        start: new Date('2026-07-27T10:00:00Z'),
        timeZone: 'Europe/Berlin',
      })
    )

    expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260720T120000')
  })

  test('can emit RECURRENCE-ID in the master timezone while start/end use the edit timezone', () => {
    const ics = unfold(
      buildInvite({
        ...baseInput,
        end: new Date('2026-07-20T17:30:00Z'),
        recurrenceId: new Date('2026-07-20T10:00:00Z'),
        recurrenceTimeZone: 'Europe/Berlin',
        start: new Date('2026-07-20T17:00:00Z'),
        timeZone: 'America/New_York',
      })
    )

    expect(ics).toContain('DTSTART;TZID=America/New_York:20260720T130000')
    expect(ics).toContain('DTEND;TZID=America/New_York:20260720T133000')
    expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260720T120000')
  })

  // An override targets one instance, so it must never also carry an RRULE —
  // that would (re)declare a whole series on the override component.
  test('suppresses the RRULE when a recurrenceId is set', () => {
    const ics = buildInvite({
      ...baseInput,
      recurrenceId: new Date('2026-06-12T10:00:00Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
    })
    expect(ics).toContain('RECURRENCE-ID:20260612T100000Z')
    expect(ics).not.toContain('RRULE')
  })

  // SCHEDULE-AGENT=NONE tells Stalwart to do no scheduling for the attendee, so
  // the edit is silent. Verified against a live Stalwart (see the attendee-delta
  // e2e): NONE suppresses iMIP delivery.
  test('stamps SCHEDULE-AGENT=NONE on every attendee when scheduleAgent is NONE', () => {
    const ics = unfold(
      buildInvite({ ...baseInput, attendees: ['a@example.com', 'b@example.com'], scheduleAgent: 'NONE' })
    )
    const attendeeLines = ics.split('\r\n').filter((l) => l.startsWith('ATTENDEE'))
    expect(attendeeLines).toHaveLength(2)
    for (const line of attendeeLines) {
      expect(line).toContain('SCHEDULE-AGENT=NONE')
    }
  })

  test('omits SCHEDULE-AGENT by default (SERVER-scheduled, notify)', () => {
    expect(buildInvite(baseInput)).not.toContain('SCHEDULE-AGENT')
    expect(buildInvite({ ...baseInput, scheduleAgent: 'SERVER' })).not.toContain('SCHEDULE-AGENT')
  })

  test('does not touch the ORGANIZER when suppressing attendee scheduling', () => {
    const ics = unfold(buildInvite({ ...baseInput, scheduleAgent: 'NONE' }))
    expect(ics).toContain('ORGANIZER;CN="host@langmail.me":mailto:host@langmail.me')
    expect(ics).not.toContain('ORGANIZER;SCHEDULE-AGENT')
  })
})

describe('maxSequence', () => {
  test('returns 0 when there is no SEQUENCE line', () => {
    expect(maxSequence('BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT')).toBe(0)
  })

  test('reads the SEQUENCE off a single VEVENT', () => {
    expect(maxSequence(buildInvite({ ...baseInput, sequence: 4 }))).toBe(4)
  })

  test('returns the highest SEQUENCE across several VEVENTs', () => {
    // A recurring object holds a master plus overrides, each with its own
    // SEQUENCE; the max is what a fresh override must bump past.
    const master = buildInvite({ ...baseInput, rrule: 'FREQ=WEEKLY', sequence: 1 })
    const override = buildInvite({ ...baseInput, recurrenceId: new Date('2026-06-19T10:00:00Z'), sequence: 5 })
    const combined = `${master}\r\n${override}`
    expect(maxSequence(combined)).toBe(5)
  })
})

describe('parseSequence', () => {
  test('reads the SEQUENCE off a serialized VEVENT', () => {
    expect(parseSequence(buildInvite({ ...baseInput, sequence: 5 }))).toBe(5)
  })

  test('round-trips the implicit zero of a fresh invite', () => {
    expect(parseSequence(buildInvite(baseInput))).toBe(0)
  })

  test('defaults to 0 when no SEQUENCE line is present', () => {
    expect(parseSequence('BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT')).toBe(0)
  })
})
