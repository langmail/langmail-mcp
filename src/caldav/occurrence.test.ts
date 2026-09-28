import { describe, expect, test } from 'bun:test'

import { parseEvents } from '@langmail/ical'

import { buildInvite } from './ical.ts'
import { spliceAlarms, spliceOccurrenceCancellation, spliceOccurrenceOverride } from './occurrence.ts'

const UID = 'series-1@langmail.me'

// RFC 5545 folds long lines at 75 octets with CRLF + space; undo that so
// substring assertions don't trip over a folded address.
const unfold = (ics: string): string => ics.replace(/\r\n /gu, '')

// A newline not preceded by a CR — i.e. a bare LF that would violate the CRLF
// line-ending invariant (RFC 5545 §3.1).
const BARE_LF_RE = /[^\r]\n/u

// A stored weekly master: Tuesdays 10:00Z from 2026-06-16, SEQUENCE 0.
const masterObject = (over: Partial<Parameters<typeof buildInvite>[0]> = {}): string =>
  buildInvite({
    attendees: ['guest@example.com'],
    description: 'Standing agenda link',
    end: new Date('2026-06-16T10:30:00Z'),
    organizer: 'host@langmail.me',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    start: new Date('2026-06-16T10:00:00Z'),
    timeZone: 'UTC',
    title: 'Weekly Sync',
    uid: UID,
    ...over,
  })

// An occurrence override for the given instant (defaults to the 2026-06-23 one).
const overrideObject = (over: Partial<Parameters<typeof buildInvite>[0]> = {}): string =>
  buildInvite({
    attendees: ['guest@example.com'],
    end: new Date('2026-06-23T11:30:00Z'),
    organizer: 'host@langmail.me',
    recurrenceId: new Date('2026-06-23T10:00:00Z'),
    sequence: 1,
    start: new Date('2026-06-23T11:00:00Z'),
    timeZone: 'UTC',
    title: 'Weekly Sync',
    uid: UID,
    ...over,
  })

describe('spliceOccurrenceOverride', () => {
  test('keeps the master (RRULE + start) and appends the override', () => {
    const merged = unfold(spliceOccurrenceOverride(masterObject(), overrideObject(), '2026-06-23T10:00:00Z'))

    // Master is untouched: its RRULE, original start and description survive.
    expect(merged).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(merged).toContain('DTSTART:20260616T100000Z')
    expect(merged).toContain('DESCRIPTION:Standing agenda link')
    // The override lands as a second VEVENT scoped to the instance.
    expect(merged).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(merged).toContain('DTSTART:20260623T110000Z')

    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
    // Both VEVENTs share the one UID — one calendar object, one series.
    expect((merged.match(new RegExp(`UID:${UID}`, 'gu')) ?? []).length).toBe(2)
  })

  test('produces exactly one VCALENDAR wrapper', () => {
    const merged = spliceOccurrenceOverride(masterObject(), overrideObject(), '2026-06-23T10:00:00Z')
    expect((merged.match(/BEGIN:VCALENDAR/gu) ?? []).length).toBe(1)
    expect((merged.match(/END:VCALENDAR/gu) ?? []).length).toBe(1)
  })

  test('guarantees a METHOD:REQUEST even when the stored object dropped it', () => {
    // Stalwart commonly strips METHOD from stored resources; the merge re-adds it
    // (it is what triggers server-side scheduling on PUT).
    const stored = masterObject().replace('METHOD:REQUEST\r\n', '')
    expect(stored).not.toContain('METHOD:REQUEST')

    const merged = spliceOccurrenceOverride(stored, overrideObject(), '2026-06-23T10:00:00Z')
    expect((merged.match(/METHOD:REQUEST/gu) ?? []).length).toBe(1)
  })

  test('does not duplicate METHOD when the stored object already has one', () => {
    const merged = spliceOccurrenceOverride(masterObject(), overrideObject(), '2026-06-23T10:00:00Z')
    expect((merged.match(/METHOD:REQUEST/gu) ?? []).length).toBe(1)
  })

  test('omits METHOD entirely when the merged object has no attendees (personal series)', () => {
    // RFC 5546 forbids a REQUEST with zero ATTENDEEs, and there is nobody to
    // schedule — mirror buildInvite's personal-event shape.
    const merged = spliceOccurrenceOverride(
      masterObject({ attendees: [] }),
      overrideObject({ attendees: [] }),
      '2026-06-23T10:00:00Z'
    )
    expect(merged).not.toContain('METHOD')
    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
  })

  test('forces METHOD:REQUEST over a stored non-REQUEST method', () => {
    // A stray METHOD:PUBLISH would stop Stalwart scheduling the iMIP update, so
    // the merge must replace it — not preserve it.
    const stored = masterObject().replace('METHOD:REQUEST', 'METHOD:PUBLISH')
    const merged = spliceOccurrenceOverride(stored, overrideObject(), '2026-06-23T10:00:00Z')
    expect(merged).not.toContain('METHOD:PUBLISH')
    expect((merged.match(/METHOD:REQUEST/gu) ?? []).length).toBe(1)
  })

  test('replaces a prior override for the same instant instead of duplicating it', () => {
    const first = spliceOccurrenceOverride(masterObject(), overrideObject(), '2026-06-23T10:00:00Z')

    const reEdited = overrideObject({
      end: new Date('2026-06-23T15:30:00Z'),
      sequence: 2,
      start: new Date('2026-06-23T15:00:00Z'),
      title: 'Weekly Sync (rescheduled)',
    })
    const merged = spliceOccurrenceOverride(first, reEdited, '2026-06-23T10:00:00Z')

    // Still one master + one override — the old override was swapped out, not
    // left behind as a second VEVENT with the same RECURRENCE-ID.
    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
    expect((merged.match(/RECURRENCE-ID/gu) ?? []).length).toBe(1)
    expect(merged).toContain('SUMMARY:Weekly Sync (rescheduled)')
    expect(merged).toContain('DTSTART:20260623T150000Z')
    expect(merged).not.toContain('DTSTART:20260623T110000Z')
  })

  test('replaces a prior TZID-qualified override across a DST boundary', () => {
    const master = masterObject({
      end: new Date('2026-03-23T09:30:00Z'),
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      start: new Date('2026-03-23T09:00:00Z'),
      timeZone: 'Europe/Berlin',
    })
    const first = spliceOccurrenceOverride(
      master,
      overrideObject({
        end: new Date('2026-03-30T10:30:00Z'),
        recurrenceId: new Date('2026-03-30T08:00:00Z'),
        start: new Date('2026-03-30T10:00:00Z'),
        timeZone: 'Europe/Berlin',
      }),
      '2026-03-30T08:00:00Z'
    )
    const second = overrideObject({
      end: new Date('2026-03-30T12:30:00Z'),
      recurrenceId: new Date('2026-03-30T08:00:00Z'),
      sequence: 2,
      start: new Date('2026-03-30T12:00:00Z'),
      timeZone: 'Europe/Berlin',
      title: 'Weekly Sync (DST edit)',
    })

    const merged = unfold(spliceOccurrenceOverride(first, second, '2026-03-30T08:00:00Z'))

    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
    expect((merged.match(/RECURRENCE-ID/gu) ?? []).length).toBe(1)
    expect(merged).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260330T100000')
    expect(merged).toContain('SUMMARY:Weekly Sync (DST edit)')
  })

  test('preserves VTIMEZONE when a non-UTC override is spliced into a UTC master', () => {
    const merged = unfold(
      spliceOccurrenceOverride(
        masterObject(),
        overrideObject({
          end: new Date('2026-06-23T13:30:00Z'),
          start: new Date('2026-06-23T13:00:00Z'),
          timeZone: 'Europe/Berlin',
        }),
        '2026-06-23T10:00:00Z'
      )
    )

    expect(merged).toContain('BEGIN:VTIMEZONE')
    expect(merged).toContain('TZID:Europe/Berlin')
    expect(merged).toContain('DTSTART;TZID=Europe/Berlin:20260623T150000')
  })

  test('leaves an unrelated occurrence override in place', () => {
    // Two different occurrences overridden in turn: both survive.
    const first = spliceOccurrenceOverride(masterObject(), overrideObject(), '2026-06-23T10:00:00Z')
    const second = overrideObject({
      end: new Date('2026-06-30T10:30:00Z'),
      recurrenceId: new Date('2026-06-30T10:00:00Z'),
      sequence: 1,
      start: new Date('2026-06-30T10:00:00Z'),
      title: 'Weekly Sync (week 3)',
    })
    const merged = spliceOccurrenceOverride(first, second, '2026-06-30T10:00:00Z')

    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(3)
    expect(merged).toContain('RECURRENCE-ID:20260623T100000Z')
    expect(merged).toContain('RECURRENCE-ID:20260630T100000Z')
  })

  test('yields a parseable calendar with the master still recurring', () => {
    const merged = spliceOccurrenceOverride(masterObject(), overrideObject(), '2026-06-23T10:00:00Z')
    const events = parseEvents(merged)
    expect(events).toHaveLength(2)
    // Exactly one VEVENT still carries the RRULE — the master.
    expect(events.filter((e) => e.recurrence !== undefined)).toHaveLength(1)
  })
})

const OCCURRENCE = '2026-06-23T10:00:00Z'

describe('spliceOccurrenceCancellation', () => {
  // RFC 5545 §3.6.1: `eventc = BEGIN:VEVENT eventprop *alarmc END:VEVENT` —
  // properties come before sub-components, so the new EXDATE/SEQUENCE must not
  // land after the master's VALARM.
  test('inserts EXDATE and SEQUENCE before the master’s VALARM', () => {
    const merged = unfold(
      spliceOccurrenceCancellation(masterObject({ alarms: [{ minutesBefore: 15 }] }), '2026-06-23T10:00:00Z')
    )
    const lines = merged.split('\r\n')
    const alarmAt = lines.indexOf('BEGIN:VALARM')
    expect(alarmAt).toBeGreaterThan(0)
    expect(lines.findIndex((l) => l.startsWith('EXDATE'))).toBeLessThan(alarmAt)
    expect(lines.findIndex((l) => l.startsWith('SEQUENCE'))).toBeLessThan(alarmAt)
  })

  test('excludes the instant on the master with an EXDATE and a bumped SEQUENCE', () => {
    const merged = unfold(spliceOccurrenceCancellation(masterObject({ sequence: 4 }), OCCURRENCE))

    // The master is untouched apart from the exclusion: RRULE and original start
    // survive, and the instant is now an EXDATE.
    expect(merged).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(merged).toContain('DTSTART:20260616T100000Z')
    expect(merged).toContain('EXDATE:20260623T100000Z')
    // SEQUENCE bumps past the master's own 4 so the CANCEL supersedes it.
    expect(merged).toContain('SEQUENCE:5')
    expect(merged).not.toContain('SEQUENCE:4')
    // Still a single (master) VEVENT — no override was introduced.
    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(1)
  })

  test('adds a SEQUENCE when the master carried none', () => {
    // masterObject() has no SEQUENCE line → implicitly 0, so the bump lands at 1.
    const merged = unfold(spliceOccurrenceCancellation(masterObject(), OCCURRENCE))
    expect(merged).toContain('SEQUENCE:1')
    expect(merged).toContain('EXDATE:20260623T100000Z')
  })

  test('drops the override for the cancelled instant', () => {
    // A master + one override for OCCURRENCE — the edited-then-cancelled shape.
    const stored = spliceOccurrenceOverride(masterObject({ sequence: 2 }), overrideObject(), OCCURRENCE)
    const merged = unfold(spliceOccurrenceCancellation(stored, OCCURRENCE))

    // The edited-then-cancelled occurrence must not leave an override dangling
    // beside its EXDATE.
    expect(merged).not.toContain('RECURRENCE-ID:20260623T100000Z')
    expect(merged).toContain('EXDATE:20260623T100000Z')
    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(1)
  })

  test('bumps only the master SEQUENCE and keeps an unrelated override verbatim', () => {
    // Master (SEQUENCE 2) + an unrelated override for 2026-06-30 (SEQUENCE 1).
    const stored = spliceOccurrenceOverride(
      masterObject({ sequence: 2 }),
      overrideObject({
        end: new Date('2026-06-30T10:30:00Z'),
        recurrenceId: new Date('2026-06-30T10:00:00Z'),
        sequence: 1,
        start: new Date('2026-06-30T10:00:00Z'),
        title: 'Weekly Sync (week 3)',
      }),
      '2026-06-30T10:00:00Z'
    )
    const merged = unfold(spliceOccurrenceCancellation(stored, OCCURRENCE))

    // The 2026-06-30 override is left in place; the master bumps past the object
    // max (2 → 3) while the override keeps its own SEQUENCE 1.
    expect(merged).toContain('RECURRENCE-ID:20260630T100000Z')
    expect(merged).toContain('SEQUENCE:3')
    expect(merged).toContain('SEQUENCE:1')
    expect((merged.match(/BEGIN:VEVENT/gu) ?? []).length).toBe(2)
  })

  test('preserves a VTIMEZONE (and its nested sub-component) verbatim', () => {
    const stored = masterObject().replace(
      'BEGIN:VEVENT',
      'BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\n' +
        'BEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\n' +
        'END:VTIMEZONE\r\nBEGIN:VEVENT'
    )
    const merged = spliceOccurrenceCancellation(stored, OCCURRENCE)

    expect(merged).toContain('TZID:Europe/Berlin')
    // The nested STANDARD must not have ended the VTIMEZONE early or been dropped.
    expect((merged.match(/BEGIN:VTIMEZONE/gu) ?? []).length).toBe(1)
    expect((merged.match(/BEGIN:STANDARD/gu) ?? []).length).toBe(1)
    expect((merged.match(/END:VTIMEZONE/gu) ?? []).length).toBe(1)
    expect(merged).toContain('EXDATE:20260623T100000Z')
  })

  test('omits METHOD when cancelling an occurrence of an attendee-less series', () => {
    const merged = spliceOccurrenceCancellation(masterObject({ attendees: [] }), '2026-06-23T10:00:00Z')
    expect(merged).not.toContain('METHOD')
    expect(merged).toContain('EXDATE:20260623T100000Z')
  })

  test('guarantees a single METHOD:REQUEST even when the stored object dropped it', () => {
    const stored = masterObject().replace('METHOD:REQUEST\r\n', '')
    expect(stored).not.toContain('METHOD:REQUEST')

    const merged = spliceOccurrenceCancellation(stored, OCCURRENCE)
    expect((merged.match(/METHOD:REQUEST/gu) ?? []).length).toBe(1)
  })

  test('is idempotent on an already-excluded instant (returns the input unchanged)', () => {
    const once = spliceOccurrenceCancellation(masterObject(), OCCURRENCE)
    const twice = spliceOccurrenceCancellation(once, OCCURRENCE)

    // The second cancel is a no-op — same bytes back, so the tool can skip the
    // PUT — and it never accretes a second EXDATE or re-bumps the SEQUENCE.
    expect(twice).toBe(once)
    expect((unfold(twice).match(/EXDATE:20260623T100000Z/gu) ?? []).length).toBe(1)
    expect((unfold(twice).match(/SEQUENCE:1/gu) ?? []).length).toBe(1)
  })

  test('joins with CRLF and one trailing CRLF', () => {
    const merged = spliceOccurrenceCancellation(masterObject(), OCCURRENCE)
    expect(merged.endsWith('\r\n')).toBe(true)
    // No bare LF: every newline is part of a CRLF pair (RFC 5545 §3.1).
    expect(BARE_LF_RE.test(merged)).toBe(false)
  })

  test('yields a parseable calendar with the master still recurring', () => {
    const events = parseEvents(spliceOccurrenceCancellation(masterObject(), OCCURRENCE))
    expect(events).toHaveLength(1)
    expect(events[0]?.recurrence).toBe('FREQ=WEEKLY;BYDAY=TU')
  })

  test('throws when the object has no rule-bearing master (invariant violation)', () => {
    // Malformed: the only RRULE-bearing VEVENT is itself an override (carries a
    // RECURRENCE-ID), so there is no clean master to exclude the instant on. The
    // tool guarantees a recurring master upstream, so rather than silently emit
    // an object with no EXDATE (and falsely report success) the splice fails loud.
    const malformed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//EN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${UID}`,
      'DTSTART:20260623T100000Z',
      'DTEND:20260623T103000Z',
      'RECURRENCE-ID:20260623T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'SUMMARY:Broken',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    expect(() => spliceOccurrenceCancellation(malformed, OCCURRENCE)).toThrow()
  })
})

describe('spliceOccurrenceCancellation — TZID exclusions', () => {
  test('treats an instant already excluded by a TZID-qualified EXDATE as a no-op re-cancel', () => {
    const master = masterObject().replace(
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEXDATE;TZID=Europe/Berlin:20260623T120000'
    )
    expect(spliceOccurrenceCancellation(master, '2026-06-23T10:00:00Z')).toBe(master)
  })
})

describe('spliceAlarms', () => {
  // RFC 5545 §3.1: component names are case-insensitive, and some producers
  // write them in lowercase. A miss here would PUT the object back unchanged
  // while the tool reported the reminder as changed.
  test('sets the reminder on a VEVENT with lowercase delimiters', () => {
    const lower = masterObject().replace('BEGIN:VEVENT', 'begin:vevent').replace('END:VEVENT', 'end:vevent')
    const out = spliceAlarms(lower, 10)
    expect(out).toContain('TRIGGER:-PT10M')
    expect(parseEvents(out)[0]?.alarms?.[0]?.trigger).toBe('-PT10M')
  })

  test('folds the alarm DESCRIPTION built from a long title', () => {
    const out = spliceAlarms(masterObject({ title: 'A'.repeat(90) }), 10)
    for (const line of out.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(unfold(out)).toContain(`DESCRIPTION:${'A'.repeat(90)}`)
  })

  test('throws rather than silently no-op when there is no VEVENT', () => {
    expect(() => spliceAlarms('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 10)).toThrow()
  })
})
