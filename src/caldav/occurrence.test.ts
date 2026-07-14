import { describe, expect, test } from 'bun:test'

import { buildInvite } from './ical.ts'
import { parseEvents } from './ical-parse.ts'
import { spliceOccurrenceOverride } from './occurrence.ts'

const UID = 'series-1@langmail.me'

// RFC 5545 folds long lines at 75 octets with CRLF + space; undo that so
// substring assertions don't trip over a folded address.
const unfold = (ics: string): string => ics.replace(/\r\n /gu, '')

// A stored weekly master: Tuesdays 10:00Z from 2026-06-16, SEQUENCE 0.
const masterObject = (over: Partial<Parameters<typeof buildInvite>[0]> = {}): string =>
  buildInvite({
    attendees: ['guest@example.com'],
    description: 'Standing agenda link',
    end: new Date('2026-06-16T10:30:00Z'),
    organizer: 'host@langmail.me',
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    start: new Date('2026-06-16T10:00:00Z'),
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
