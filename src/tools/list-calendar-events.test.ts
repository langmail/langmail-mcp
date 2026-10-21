import { describe, expect, test } from 'bun:test'

import { type FetchEventsParams } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { type ListCalendarEventsArgs, listCalendarEvents, listCalendarEventsInput } from './list-calendar-events.ts'

const CAL = 'https://m/dav/cal/u/default/'

const account = (over: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  calendars: [{ displayName: 'Default', url: CAL }],
  defaultCalendarUrl: CAL,
  organizer: 'host@langmail.me',
  ...over,
})

const event = (uid: string, title: string, start: string, end: string): CalendarObject => ({
  data: buildInvite({
    attendees: ['guest@example.com'],
    end: new Date(end),
    organizer: 'host@langmail.me',
    start: new Date(start),
    timeZone: 'UTC',
    title,
    uid,
  }),
  url: `${CAL}${uid}.ics`,
})

const makeDeps = (acc: DiscoveredAccount, objects: CalendarObject[], captured: FetchEventsParams[] = []) => ({
  discover: () => Promise.resolve(acc),
  fetchEvents: (p: FetchEventsParams) => {
    captured.push(p)
    return Promise.resolve(objects)
  },
})

describe('listCalendarEventsInput schema', () => {
  test('accepts an empty input', () => {
    expect(listCalendarEventsInput.safeParse({}).success).toBe(true)
  })

  test('rejects a non-ISO start', () => {
    expect(listCalendarEventsInput.safeParse({ start: 'soon' }).success).toBe(false)
  })
})

describe('listCalendarEvents', () => {
  test('lists events sorted by start with their uids', async () => {
    const objects = [
      event('later@langmail.me', 'Later', '2026-06-12T15:00:00Z', '2026-06-12T16:00:00Z'),
      event('early@langmail.me', 'Early', '2026-06-12T09:00:00Z', '2026-06-12T10:00:00Z'),
    ]
    const result = await listCalendarEvents(makeDeps(account(), objects), { args: {}, token: 'tok' })

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('2 event(s)')
    expect(txt).toContain('uid: early@langmail.me')
    expect(txt).toContain('uid: later@langmail.me')
    // Sorted ascending: "Early" appears before "Later".
    expect(txt.indexOf('Early')).toBeLessThan(txt.indexOf('Later'))
  })

  test('lists TZID-qualified events with their timezone', async () => {
    const object: CalendarObject = {
      data: buildInvite({
        attendees: ['guest@example.com'],
        end: new Date('2026-07-20T10:30:00Z'),
        organizer: 'host@langmail.me',
        start: new Date('2026-07-20T10:00:00Z'),
        timeZone: 'Europe/Berlin',
        title: 'Berlin Lunch',
        uid: 'berlin@langmail.me',
      }),
      url: `${CAL}berlin.ics`,
    }

    const result = await listCalendarEvents(makeDeps(account(), [object]), { args: {}, token: 'tok' })

    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('when: 2026-07-20T12:00:00 → 2026-07-20T12:30:00 (Europe/Berlin)')
  })

  test('passes a time range through when both bounds are given', async () => {
    const captured: FetchEventsParams[] = []
    const args: ListCalendarEventsArgs = { end: '2026-06-13T00:00:00Z', start: '2026-06-12T00:00:00Z' }
    await listCalendarEvents(makeDeps(account(), [], captured), { args, token: 'tok' })
    expect(captured[0]?.timeRange).toEqual({ end: '2026-06-13T00:00:00Z', start: '2026-06-12T00:00:00Z' })
  })

  test('omits the time range when neither bound is given', async () => {
    const captured: FetchEventsParams[] = []
    await listCalendarEvents(makeDeps(account(), [], captured), { args: {}, token: 'tok' })
    expect(captured[0]?.timeRange).toBeUndefined()
  })

  test('errors when only one of start/end is provided', async () => {
    const captured: FetchEventsParams[] = []
    const result = await listCalendarEvents(makeDeps(account(), [], captured), {
      args: { start: '2026-06-12T00:00:00Z' },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  })

  test('lists each event’s attendees so an attendee edit reads from Langmail', async () => {
    const object: CalendarObject = {
      data: buildInvite({
        attendees: ['kai@atelier.example', 'mika@example.com', 'jo@example.com'],
        end: new Date('2026-06-12T10:30:00Z'),
        organizer: 'host@langmail.me',
        start: new Date('2026-06-12T10:00:00Z'),
        timeZone: 'UTC',
        title: 'Team sync',
        uid: 'team@langmail.me',
      }),
      url: `${CAL}team.ics`,
    }
    const result = await listCalendarEvents(makeDeps(account(), [object]), { args: {}, token: 'tok' })
    expect(result.content[0]?.text).toContain('attendees: kai@atelier.example, mika@example.com, jo@example.com')
  })

  test('annotates a non-default PARTSTAT and leaves NEEDS-ACTION bare', async () => {
    const object: CalendarObject = {
      data: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:rsvp@langmail.me',
        'SUMMARY:RSVP status',
        'DTSTART:20260612T100000Z',
        'DTEND:20260612T103000Z',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:yes@example.com',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:pending@example.com',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      url: `${CAL}rsvp.ics`,
    }
    const result = await listCalendarEvents(makeDeps(account(), [object]), { args: {}, token: 'tok' })
    expect(result.content[0]?.text).toContain('attendees: yes@example.com (accepted), pending@example.com')
  })

  test('omits the attendees line for an event with none', async () => {
    const object: CalendarObject = {
      data: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:solo@langmail.me\r\nSUMMARY:Solo\r\nDTSTART:20260612T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
      url: `${CAL}solo.ics`,
    }
    const result = await listCalendarEvents(makeDeps(account(), [object]), { args: {}, token: 'tok' })
    expect(result.content[0]?.text).not.toContain('attendees:')
  })

  test('reports when there are no events', async () => {
    const result = await listCalendarEvents(makeDeps(account(), []), { args: {}, token: 'tok' })
    expect(result.content[0]?.text).toContain('No events found')
  })

  test('errors when the explicit calendarUrl is unknown', async () => {
    const result = await listCalendarEvents(makeDeps(account(), []), {
      args: { calendarUrl: 'https://m/dav/cal/u/ghost/' },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('ghost')
  })
})

describe('listCalendarEvents — all-day events and reminders', () => {
  const vacation: CalendarObject = {
    data: buildInvite({
      alarms: [{ minutesBefore: 1440 }],
      allDay: true,
      attendees: [],
      end: new Date('2026-10-11T00:00:00Z'),
      start: new Date('2026-10-03T00:00:00Z'),
      title: 'Vacation',
      uid: 'vacation-1',
    }),
    url: `${CAL}vacation-1.ics`,
  }
  const sync: CalendarObject = {
    data: buildInvite({
      alarms: [{ minutesBefore: 30 }, { minutesBefore: 5 }],
      attendees: [],
      end: new Date('2026-10-02T10:30:00Z'),
      start: new Date('2026-10-02T10:00:00Z'),
      title: 'Sync',
      uid: 'sync-1',
    }),
    url: `${CAL}sync-1.ics`,
  }

  const list = async (objects: CalendarObject[]): Promise<string> =>
    (await listCalendarEvents(makeDeps(account(), objects), { args: {}, token: 'tok' })).content[0]?.text ?? ''

  test('an all-day event shows its dates, no clock time, and says the end is exclusive', async () => {
    const txt = await list([vacation])
    expect(txt).toContain('when: 2026-10-03 → 2026-10-11 (all day; end date exclusive)')
    expect(txt).not.toContain('T00:00')
  })

  test('shows an all-day reminder as the clock time it fires', async () => {
    // 1440 minutes before a 00:00 start is midnight, not "a day before" at a sensible hour.
    expect(await list([vacation])).toContain('reminder: 00:00 the day before')
  })

  test('shows 900 minutes before an all-day event as 09:00 the day before', async () => {
    const morning = { ...vacation, data: vacation.data.replace('TRIGGER:-P1D', 'TRIGGER:-PT15H') }
    expect(await list([morning])).toContain('reminder: 09:00 the day before')
  })

  test('shows several reminders on one line', async () => {
    expect(await list([sync])).toContain('reminders: 30 minutes before start, 5 minutes before start')
  })

  test('keeps sub-minute precision instead of rounding', async () => {
    const odd = {
      ...sync,
      data: sync.data.replace('TRIGGER:-PT30M', 'TRIGGER:-PT90S').replace('TRIGGER:-PT5M', 'TRIGGER:-PT29S'),
    }
    expect(await list([odd])).toContain('reminders: 1 minute 30 seconds before start, 29 seconds before start')
  })

  test('renders a mixed duration as minutes plus the leftover seconds', async () => {
    const odd = { ...sync, data: sync.data.replace('TRIGGER:-PT30M', 'TRIGGER:-PT1H1M30S') }
    expect(await list([odd])).toContain('61 minutes 30 seconds before start')
  })

  test('an event without alarms has no reminder line', async () => {
    const txt = await list([event('plain', 'Plain', '2026-06-12T09:00:00Z', '2026-06-12T10:00:00Z')])
    expect(txt).not.toContain('reminder')
  })

  test('an absolute trigger is shown as an instant', async () => {
    const absolute: CalendarObject = {
      ...sync,
      data: buildInvite({
        alarms: [
          {
            lines: [
              'BEGIN:VALARM',
              'ACTION:DISPLAY',
              'TRIGGER;VALUE=DATE-TIME:20261002T090000Z',
              'DESCRIPTION:Sync',
              'END:VALARM',
            ],
          },
        ],
        attendees: [],
        end: new Date('2026-10-02T10:30:00Z'),
        start: new Date('2026-10-02T10:00:00Z'),
        title: 'Sync',
        uid: 'sync-1',
      }),
    }
    expect(await list([absolute])).toContain('reminder: at 2026-10-02T09:00:00Z')
  })
})

// A weekly Tuesday 16:00 Berlin series from 2026-09-29: the occurrence of
// 2026-10-20 moved to Thursday 2026-10-22, and the one of 2026-10-27 answered
// by the attendee alone — an override with no SUMMARY or DTSTART of its own.
const weeklySync: CalendarObject = {
  data: [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:weekly@langmail.me',
    'SUMMARY:Weekly sync',
    'DTSTART;TZID=Europe/Berlin:20260929T160000',
    'DTEND;TZID=Europe/Berlin:20260929T164500',
    'RRULE:FREQ=WEEKLY;BYDAY=TU',
    'EXDATE;TZID=Europe/Berlin:20261013T160000',
    'ORGANIZER:mailto:host@langmail.me',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:host@langmail.me',
    'ATTENDEE:mailto:robin@example.com',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@langmail.me',
    'RECURRENCE-ID;TZID=Europe/Berlin:20261020T160000',
    'SUMMARY:Weekly sync',
    'DTSTART;TZID=Europe/Berlin:20261022T160000',
    'DTEND;TZID=Europe/Berlin:20261022T164500',
    'ORGANIZER:mailto:host@langmail.me',
    'ATTENDEE:mailto:host@langmail.me',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:robin@example.com',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@langmail.me',
    'RECURRENCE-ID;TZID=Europe/Berlin:20261027T160000',
    'ATTENDEE;PARTSTAT=DECLINED:mailto:robin@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'),
  url: `${CAL}weekly.ics`,
}

const listWindow = async (objects: CalendarObject[], start: string, end: string): Promise<string> =>
  (await listCalendarEvents(makeDeps(account(), objects), { args: { end, start }, token: 'tok' })).content[0]?.text ??
  ''

describe('listCalendarEvents — occurrences in a window', () => {
  test('lists a series’ occurrence on the requested day at its own time, not the series start', async () => {
    const txt = await listWindow([weeklySync], '2026-10-06T00:00:00+02:00', '2026-10-07T00:00:00+02:00')
    expect(txt).toContain('1 event(s) between')
    expect(txt).toContain('when: 2026-10-06T16:00:00 → 2026-10-06T16:45:00 (Europe/Berlin)')
    expect(txt).toContain('repeats: FREQ=WEEKLY;BYDAY=TU')
    expect(txt).toContain('recurrenceId: 2026-10-06T14:00:00Z')
    expect(txt).not.toContain('2026-09-29')
  })

  test('a moved occurrence is listed on its new day with its original start, and not on the old one', async () => {
    const tuesday = await listWindow([weeklySync], '2026-10-20T00:00:00+02:00', '2026-10-21T00:00:00+02:00')
    expect(tuesday).toContain('No events between')

    const thursday = await listWindow([weeklySync], '2026-10-22T00:00:00+02:00', '2026-10-23T00:00:00+02:00')
    expect(thursday).toContain('when: 2026-10-22T16:00:00 → 2026-10-22T16:45:00 (Europe/Berlin)')
    expect(thursday).toContain('moved from: 2026-10-20T16:00:00 (Europe/Berlin)')
    expect(thursday).toContain('recurrenceId: 2026-10-20T14:00:00Z')
    expect(thursday).toContain('attendees: host@langmail.me, robin@example.com (accepted)')
  })

  test('names the organizer and marks the user', async () => {
    const txt = await listWindow([weeklySync], '2026-10-22T00:00:00+02:00', '2026-10-23T00:00:00+02:00')
    expect(txt).toContain('organizer: host@langmail.me (you)')
  })

  test('an attendee-only override reads its title, time and organizer from the series', async () => {
    const txt = await listWindow([weeklySync], '2026-10-27T00:00:00+01:00', '2026-10-28T00:00:00+01:00')
    expect(txt).toContain('1. Weekly sync')
    // 2026-10-27 is after the DST change: 16:00 Berlin is 15:00 UTC.
    expect(txt).toContain('when: 2026-10-27T16:00:00 → 2026-10-27T16:45:00 (Europe/Berlin)')
    expect(txt).toContain('recurrenceId: 2026-10-27T15:00:00Z')
    expect(txt).toContain('organizer: host@langmail.me (you)')
    expect(txt).toContain('attendees: robin@example.com (declined)')
    expect(txt).not.toContain('moved from')
    expect(txt).not.toContain('(no title)')
  })

  test('skips an excluded occurrence', async () => {
    const txt = await listWindow([weeklySync], '2026-10-13T00:00:00+02:00', '2026-10-14T00:00:00+02:00')
    expect(txt).toContain('No events between')
  })

  test('a week lists each occurrence once, sorted, and leaves out the rest of the series', async () => {
    const lunch = event('lunch@langmail.me', 'Lunch', '2026-10-19T10:00:00Z', '2026-10-19T11:00:00Z')
    const outside = event('outside@langmail.me', 'Outside', '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z')
    const txt = await listWindow([weeklySync, outside, lunch], '2026-10-19T00:00:00+02:00', '2026-10-26T00:00:00+01:00')
    expect(txt).toContain('2 event(s) between')
    expect(txt.indexOf('Lunch')).toBeLessThan(txt.indexOf('Weekly sync'))
    expect(txt).not.toContain('Outside')
  })

  test('an occurrence that started before the window but runs into it is listed', async () => {
    const txt = await listWindow([weeklySync], '2026-10-06T16:30:00+02:00', '2026-10-06T18:00:00+02:00')
    expect(txt).toContain('when: 2026-10-06T16:00:00 → 2026-10-06T16:45:00 (Europe/Berlin)')
  })

  test('expands a UTC series and an all-day series', async () => {
    const standup: CalendarObject = {
      data: buildInvite({
        attendees: [],
        end: new Date('2026-10-01T09:15:00Z'),
        rrule: 'FREQ=DAILY',
        start: new Date('2026-10-01T09:00:00Z'),
        timeZone: 'UTC',
        title: 'Standup',
        uid: 'standup@langmail.me',
      }),
      url: `${CAL}standup.ics`,
    }
    const gym: CalendarObject = {
      data: buildInvite({
        allDay: true,
        attendees: [],
        end: new Date('2026-10-02T00:00:00Z'),
        rrule: 'FREQ=WEEKLY',
        start: new Date('2026-10-01T00:00:00Z'),
        title: 'Gym day',
        uid: 'gym@langmail.me',
      }),
      url: `${CAL}gym.ics`,
    }
    const txt = await listWindow([standup, gym], '2026-10-22T00:00:00+02:00', '2026-10-23T00:00:00+02:00')
    expect(txt).toContain('when: 2026-10-22T09:00:00Z → 2026-10-22T09:15:00Z')
    expect(txt).toContain('recurrenceId: 2026-10-22T09:00:00Z')
    expect(txt).toContain('when: 2026-10-22 → 2026-10-23 (all day; end date exclusive)')
    expect(txt).toContain('recurrenceId: 2026-10-22\n')
    expect(txt).not.toContain('2026-10-21')
    // The all-day entry sorts first: it starts at the caller's midnight.
    expect(txt.indexOf('Gym day')).toBeLessThan(txt.indexOf('Standup'))
  })

  test('caps a long listing and says how to narrow it', async () => {
    const standup: CalendarObject = {
      data: buildInvite({
        attendees: [],
        end: new Date('2026-01-01T09:15:00Z'),
        rrule: 'FREQ=DAILY',
        start: new Date('2026-01-01T09:00:00Z'),
        timeZone: 'UTC',
        title: 'Standup',
        uid: 'standup@langmail.me',
      }),
      url: `${CAL}standup.ics`,
    }
    const txt = await listWindow([standup], '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    expect(txt).toContain('365 event(s) between')
    expect(txt).toContain('Showing the first 200. Narrow start/end to see the rest.')
  })
})

describe('listCalendarEvents — without a window', () => {
  test('lists the series once and each override completed from it, with its original start', async () => {
    const txt = (await listCalendarEvents(makeDeps(account(), [weeklySync]), { args: {}, token: 'tok' })).content[0]
      ?.text
    expect(txt).toContain('3 event(s), each series once at its first occurrence')
    expect(txt).toContain('when: 2026-09-29T16:00:00 → 2026-09-29T16:45:00 (Europe/Berlin)')
    expect(txt).toContain('moved from: 2026-10-20T16:00:00 (Europe/Berlin)')
    expect(txt).not.toContain('(no title)')
  })

  test('does not mark an organizer who is someone else', async () => {
    const other = {
      ...weeklySync,
      data: weeklySync.data.replaceAll('ORGANIZER:mailto:host@', 'ORGANIZER:mailto:boss@'),
    }
    const txt = (await listCalendarEvents(makeDeps(account(), [other]), { args: {}, token: 'tok' })).content[0]?.text
    expect(txt).toContain('organizer: boss@langmail.me\n')
  })
})
