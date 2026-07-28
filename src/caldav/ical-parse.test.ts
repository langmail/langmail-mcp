import { describe, expect, test } from 'bun:test'

import { buildInvite } from './ical.ts'
import { parseEvents } from './ical-parse.ts'

const sample = buildInvite({
  attendees: ['guest@example.com'],
  description: 'Quarterly review',
  end: new Date('2026-06-12T10:30:00Z'),
  location: 'Room 4',
  organizer: 'host@langmail.me',
  start: new Date('2026-06-12T10:00:00Z'),
  title: 'Sync',
  uid: 'evt-1@langmail.me',
})

describe('parseEvents', () => {
  test('extracts uid, title, ISO times, and location from a built invite', () => {
    const [ev, ...rest] = parseEvents(sample)
    expect(rest).toHaveLength(0)
    expect(ev?.uid).toBe('evt-1@langmail.me')
    expect(ev?.title).toBe('Sync')
    expect(ev?.start).toBe('2026-06-12T10:00:00Z')
    expect(ev?.end).toBe('2026-06-12T10:30:00Z')
    expect(ev?.location).toBe('Room 4')
  })

  test('extracts the RRULE of a recurring event', () => {
    const ics = buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: 'host@langmail.me',
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Weekly sync',
      uid: 'evt-r@langmail.me',
    })
    expect(parseEvents(ics)[0]?.recurrence).toBe('FREQ=WEEKLY;BYDAY=TH')
  })

  test('omits recurrence for a one-off event', () => {
    expect(parseEvents(sample)[0]?.recurrence).toBeUndefined()
  })

  test('trims trailing whitespace a server may emit on the RRULE line', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:evt-w@langmail.me\r\nRRULE:FREQ=WEEKLY \r\nEND:VEVENT'
    expect(parseEvents(ics)[0]?.recurrence).toBe('FREQ=WEEKLY')
  })

  test('omits location when absent', () => {
    const ics = buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: 'host@langmail.me',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'No place',
      uid: 'evt-2@langmail.me',
    })
    expect(parseEvents(ics)[0]?.location).toBeUndefined()
  })

  test('parses multiple VEVENTs in one calendar', () => {
    const combined = `${sample}\r\n${buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-13T09:30:00Z'),
      organizer: 'host@langmail.me',
      start: new Date('2026-06-13T09:00:00Z'),
      title: 'Second',
      uid: 'evt-3@langmail.me',
    })}`
    const events = parseEvents(combined)
    expect(events.map((e) => e.uid)).toEqual(['evt-1@langmail.me', 'evt-3@langmail.me'])
  })

  test('skips a VEVENT without a UID', () => {
    expect(parseEvents('BEGIN:VEVENT\r\nSUMMARY:Orphan\r\nEND:VEVENT')).toHaveLength(0)
  })

  test('unescapes TEXT values and unfolds folded lines', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:x@langmail.me',
      'SUMMARY:Lunch\\, then a very long title that the',
      ' server folded',
      'END:VEVENT',
    ].join('\r\n')
    const [ev] = parseEvents(ics)
    expect(ev?.title).toBe('Lunch, then a very long title that theserver folded')
  })

  test('keeps a date-only value as a calendar date', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:allday@langmail.me\r\nDTSTART:20260612\r\nEND:VEVENT'
    expect(parseEvents(ics)[0]?.start).toBe('2026-06-12')
  })

  test('does not let a nested VALARM SUMMARY clobber the event title', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:a@langmail.me',
      'SUMMARY:Real meeting',
      'DTSTART:20260612T100000Z',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'SUMMARY:Reminder',
      'END:VALARM',
      'END:VEVENT',
    ].join('\r\n')
    const [ev] = parseEvents(ics)
    expect(ev?.title).toBe('Real meeting')
  })

  test('extracts the bare organizer email, mailto: stripped', () => {
    const [ev] = parseEvents(sample)
    expect(ev?.organizer).toBe('host@langmail.me')
  })

  test('reads the organizer past params carrying quoted colons', () => {
    // Foreign clients (delegation, display names) put colons inside quoted
    // params; the cal-address is the mailto: URI at the end of the line.
    const ics = [
      'BEGIN:VEVENT',
      'UID:c@langmail.me',
      'ORGANIZER;SENT-BY="mailto:assistant@x.com";CN="Team: Weekly":mailto:boss@x.com',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.organizer).toBe('boss@x.com')
  })

  test('omits an organizer it cannot reduce to a bare address', () => {
    // A non-mailto cal-address (e.g. a principal URL) is useless for rebuilding
    // an invite — better absent (callers fall back to discovery) than garbage.
    const ics = [
      'BEGIN:VEVENT',
      'UID:d@langmail.me',
      'ORGANIZER;SENT-BY="mailto:assistant@x.com":/principals/users/boss/',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.organizer).toBeUndefined()
  })

  test('omits organizer when the event has none', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:e@langmail.me\r\nSUMMARY:No invitees\r\nEND:VEVENT'
    expect(parseEvents(ics)[0]?.organizer).toBeUndefined()
  })

  test('decodes an escaped backslash without turning it into a newline', () => {
    // RFC 5545: `\\` is a literal backslash, so `\\n` is backslash + "n".
    const ics = 'BEGIN:VEVENT\r\nUID:b@langmail.me\r\nSUMMARY:path C:\\\\new\r\nEND:VEVENT'
    expect(parseEvents(ics)[0]?.title).toBe('path C:\\new')
  })

  test('extracts every attendee as a bare email, in source order', () => {
    const ics = buildInvite({
      attendees: ['kai@atelier.example', 'mika@example.com', 'jo@example.com'],
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: 'host@langmail.me',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Team',
      uid: 'evt-att@langmail.me',
    })
    expect(parseEvents(ics)[0]?.attendees.map((a) => a.email)).toEqual([
      'kai@atelier.example',
      'mika@example.com',
      'jo@example.com',
    ])
  })

  test('reads each attendee PARTSTAT when present', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:evt-partstat@langmail.me',
      'ATTENDEE;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:yes@example.com',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:no@example.com',
      'ATTENDEE;RSVP=TRUE:mailto:pending@example.com',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.attendees).toEqual([
      { email: 'yes@example.com', status: 'ACCEPTED' },
      { email: 'no@example.com', status: 'DECLINED' },
      { email: 'pending@example.com' },
    ])
  })

  test('gives an attendee-less event an empty attendee list', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:solo@langmail.me\r\nSUMMARY:Solo\r\nEND:VEVENT'
    expect(parseEvents(ics)[0]?.attendees).toEqual([])
  })

  test('reads an attendee address and PARTSTAT past params carrying quoted colons', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:evt-q@langmail.me',
      'ATTENDEE;CN="Team: Weekly";PARTSTAT=ACCEPTED:mailto:person@example.com',
      'END:VEVENT',
    ].join('\r\n')
    // The quoted colon in CN pushes the first-colon split into the CN value, so
    // PARTSTAT must be recovered from the reassembled line, not the truncated params.
    expect(parseEvents(ics)[0]?.attendees[0]).toEqual({ email: 'person@example.com', status: 'ACCEPTED' })
  })

  test('drops an attendee it cannot reduce to a bare address', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:evt-bad@langmail.me',
      'ATTENDEE:/principals/users/someone/',
      'ATTENDEE:mailto:good@example.com',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.attendees).toEqual([{ email: 'good@example.com' }])
  })

  test('counts attendees it could not parse (a non-mailto cal-address)', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:evt-urn@langmail.me',
      'ATTENDEE;CN=Jane;EMAIL=jane@example.com:urn:uuid:1234',
      'ATTENDEE:mailto:good@example.com',
      'END:VEVENT',
    ].join('\r\n')
    const [ev] = parseEvents(ics)
    expect(ev?.attendees).toEqual([{ email: 'good@example.com' }])
    expect(ev?.unparsedAttendeeCount).toBe(1)
  })

  test('omits unparsedAttendeeCount when every attendee parsed cleanly', () => {
    expect(parseEvents(sample)[0]?.unparsedAttendeeCount).toBeUndefined()
  })

  test('extracts the DESCRIPTION, unescaped', () => {
    const ics = buildInvite({
      attendees: ['guest@example.com'],
      description: 'Line one; line two',
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: 'host@langmail.me',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'With notes',
      uid: 'evt-desc@langmail.me',
    })
    expect(parseEvents(ics)[0]?.description).toBe('Line one; line two')
  })

  test('omits description when absent', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:nodesc@langmail.me\r\nSUMMARY:No notes\r\nEND:VEVENT'
    expect(parseEvents(ics)[0]?.description).toBeUndefined()
  })

  test('reads a UTC RECURRENCE-ID as the overridden instant', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:series@langmail.me',
      'SUMMARY:Moved occurrence',
      'RECURRENCE-ID:20260623T100000Z',
      'DTSTART:20260623T110000Z',
      'DTEND:20260623T120000Z',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.recurrenceId).toBe('2026-06-23T10:00:00.000Z')
  })

  test('resolves a zoned RECURRENCE-ID against its TZID', () => {
    // 10:00 Berlin on 2026-06-23 (CEST, UTC+2) is the 08:00Z instant.
    const ics = [
      'BEGIN:VEVENT',
      'UID:series@langmail.me',
      'SUMMARY:Moved occurrence',
      'RECURRENCE-ID;TZID=Europe/Berlin:20260623T100000',
      'DTSTART;TZID=Europe/Berlin:20260623T110000',
      'DTEND;TZID=Europe/Berlin:20260623T120000',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.recurrenceId).toBe('2026-06-23T08:00:00.000Z')
  })

  test('omits recurrenceId on a master and on a one-off event', () => {
    expect(parseEvents(sample)[0]?.recurrenceId).toBeUndefined()
  })

  test('drops an unparsable RECURRENCE-ID rather than surfacing garbage', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:series@langmail.me',
      'SUMMARY:Broken override',
      'RECURRENCE-ID:not-a-date',
      'END:VEVENT',
    ].join('\r\n')
    expect(parseEvents(ics)[0]?.recurrenceId).toBeUndefined()
  })
})
