import { describe, expect, test } from 'bun:test'

import { buildInvite } from './ical.ts'

// RFC 5545 folds long lines at 75 octets with a CRLF + space; undo that
// so substring assertions don't trip over a folded email address.
const unfold = (ics: string): string => ics.replace(/\r\n /gu, '')

const baseInput = {
  attendees: ['guest@example.com'],
  end: new Date('2026-06-12T10:30:00Z'),
  organizer: 'host@langmail.me',
  start: new Date('2026-06-12T10:00:00Z'),
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

  test('adds each attendee with RSVP and NEEDS-ACTION', () => {
    const ics = unfold(buildInvite({ ...baseInput, attendees: ['a@example.com', 'b@example.com'] }))
    expect(ics).toContain('a@example.com')
    expect(ics).toContain('b@example.com')
    expect(ics).toContain('RSVP=TRUE')
    expect(ics).toContain('PARTSTAT=NEEDS-ACTION')
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
})
