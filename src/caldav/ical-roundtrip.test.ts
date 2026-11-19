import { describe, expect, test } from 'bun:test'

import { parseEvents } from '../ical/index.ts'
import { buildInvite } from './ical.ts'

// Writer↔parser fidelity: buildInvite (ical-generator, this service) must
// stay parseable by src/ical's read-side parser — the pure-fixture
// tests live in the package, this roundtrip pins the real writer's output.
describe('buildInvite → parseEvents roundtrip', () => {
  test('a built invite parses back with uid, title, times, attendees, and organizer intact', () => {
    const ics = buildInvite({
      attendees: ['kai@atelier.example', 'mika@example.com'],
      description: 'Quarterly review; agenda attached',
      end: new Date('2026-06-12T10:30:00Z'),
      location: 'Room 4',
      organizer: 'host@langmail.me',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Sync',
      uid: 'evt-rt@langmail.me',
    })
    const [ev, ...rest] = parseEvents(ics)
    expect(rest).toHaveLength(0)
    expect(ev?.uid).toBe('evt-rt@langmail.me')
    expect(ev?.title).toBe('Sync')
    expect(ev?.start).toBe('2026-06-12T10:00:00Z')
    expect(ev?.end).toBe('2026-06-12T10:30:00Z')
    expect(ev?.location).toBe('Room 4')
    expect(ev?.description).toBe('Quarterly review; agenda attached')
    expect(ev?.organizer).toBe('host@langmail.me')
    expect(ev?.attendees.map((a) => a.email)).toEqual(['kai@atelier.example', 'mika@example.com'])
    expect(ev?.unparsedAttendeeCount).toBeUndefined()
  })

  test('a recurring built invite parses back with its RRULE', () => {
    const ics = buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: 'host@langmail.me',
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Weekly sync',
      uid: 'evt-rt-r@langmail.me',
    })
    expect(parseEvents(ics)[0]?.recurrence).toBe('FREQ=WEEKLY;BYDAY=TH')
  })

  test.each(['busy', 'free'] as const)('showAs %s parses back', (showAs) => {
    const ics = buildInvite({
      attendees: [],
      end: new Date('2026-06-12T10:30:00Z'),
      showAs,
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Hold',
      uid: 'evt-rt-s',
    })
    expect(parseEvents(ics)[0]?.showAs).toBe(showAs)
  })
})
