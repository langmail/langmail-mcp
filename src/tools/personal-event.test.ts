import { describe, expect, test } from 'bun:test'

import { buildInvite } from '../caldav/ical.ts'
import { parseEvents } from '../ical/index.ts'
import { hasOtherPeople } from './personal-event.ts'

const SELF = 'me@langmail.example'

const event = (attendees: string[], organizer?: string) =>
  parseEvents(
    buildInvite({
      attendees,
      end: new Date('2026-06-12T10:30:00Z'),
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Event',
      uid: 'evt-1',
      ...(organizer ? { organizer } : {}),
    })
  )

describe('hasOtherPeople', () => {
  test('an event with no attendees is personal, with or without an organizer', () => {
    expect(hasOtherPeople(event([]), SELF)).toBe(false)
    expect(hasOtherPeople(event([], SELF), SELF)).toBe(false)
  })

  test('the user as the only attendee of their own event is personal, in any letter case', () => {
    expect(hasOtherPeople(event(['Me@Langmail.Example'], SELF), SELF)).toBe(false)
  })

  test('anyone else as an attendee is a meeting', () => {
    expect(hasOtherPeople(event([SELF, 'guest@example.com'], SELF), SELF)).toBe(true)
  })

  test('an invitation the user received counts, even with only the user as attendee', () => {
    expect(hasOtherPeople(event([SELF], 'organizer@example.com'), SELF)).toBe(true)
  })

  test('without an own address every attendee is someone else', () => {
    expect(hasOtherPeople(event([SELF], SELF), '')).toBe(true)
  })
})
