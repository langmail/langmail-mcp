import { describe, expect, test } from 'bun:test'

import { parseEvents } from '@langmail/ical'

import { agendaWindow, windowEntries } from '../caldav/agenda.ts'
import { EMPTY_FEED_NAME, renderEmptyFeed, renderFeed, type ShareLevel } from './render.ts'

const OWNER = 'owner@example.com'
const NOW = new Date('2026-11-13T12:00:00Z')
const WINDOW = agendaWindow('2026-10-14T00:00:00Z', '2027-11-13T00:00:00Z')

const OPAQUE_UID_RE = /^UID:[0-9a-f]{32}@calendar-share\.langmail\.me$/u

const vevent = (lines: string[]): string => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')
const calendar = (...vevents: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents, 'END:VCALENDAR'].join('\r\n')

const event = (uid: string, extra: string[] = []): string =>
  vevent([
    `UID:${uid}`,
    'DTSTART:20261120T090000Z',
    'DTEND:20261120T100000Z',
    `SUMMARY:Title ${uid}`,
    'LOCATION:Room 1',
    'DESCRIPTION:Notes',
    'ORGANIZER:mailto:boss@example.com',
    `ATTENDEE;CN=Owner;PARTSTAT=ACCEPTED:mailto:${OWNER}`,
    'ATTENDEE;CN="Guest, A";PARTSTAT=NEEDS-ACTION:mailto:guest@example.com',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'END:VALARM',
    ...extra,
  ])

const render = (level: ShareLevel, ...objects: string[]): string =>
  renderFeed({
    entries: objects.flatMap((o) => windowEntries(parseEvents(o), WINDOW)),
    level,
    name: 'Personal',
    now: NOW,
    ownerAddress: OWNER,
    shareId: 'share-1',
  })

const summaries = (feed: string): string[] =>
  feed
    .split('\r\n')
    .filter((l) => l.startsWith('SUMMARY:'))
    .map((l) => l.slice('SUMMARY:'.length))

// The feed's VEVENTs, each as its unfolded lines.
const events = (feed: string): string[][] =>
  feed
    .replace(/\r\n /gu, '')
    .split('BEGIN:VEVENT\r\n')
    .slice(1)
    .map((block) => block.split('\r\n').filter((l) => l !== '' && l !== 'END:VEVENT' && l !== 'END:VCALENDAR'))

describe('renderFeed — the calendar', () => {
  test('names the calendar, asks for hourly refresh and uses CRLF', () => {
    const feed = render('busy')
    expect(feed).toContain('X-WR-CALNAME:Personal\r\n')
    expect(feed).toContain('NAME:Personal\r\n')
    expect(feed).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n')
    expect(feed).toContain('X-PUBLISHED-TTL:PT1H\r\n')
    expect(feed).toContain('METHOD:PUBLISH\r\n')
    expect(feed.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  test('the empty feed is the same whatever the reason', () => {
    expect(renderEmptyFeed()).toBe(renderEmptyFeed())
    expect(renderEmptyFeed()).toContain(`X-WR-CALNAME:${EMPTY_FEED_NAME}`)
    expect(renderEmptyFeed()).not.toContain('BEGIN:VEVENT')
  })

  test('folds long lines at 75 octets', () => {
    const feed = render('full', calendar(event('long', ['COMMENT:x']).replace('Notes', 'ä'.repeat(100))))
    for (const line of feed.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(events(feed)[0]).toContain(`DESCRIPTION:${'ä'.repeat(100)}`)
  })
})

describe('renderFeed — busy only', () => {
  test('shows start and end titled Busy, and nothing else', () => {
    const [lines] = events(render('busy', calendar(event('a'))))
    expect(lines?.filter((l) => !(l.startsWith('UID:') || l.startsWith('DTSTAMP:')))).toEqual([
      'DTSTART:20261120T090000Z',
      'DTEND:20261120T100000Z',
      'SUMMARY:Busy',
      'TRANSP:OPAQUE',
    ])
    expect(lines?.find((l) => l.startsWith('UID:'))).toMatch(OPAQUE_UID_RE)
  })

  test('drops free, cancelled and declined events', () => {
    const feed = render(
      'busy',
      calendar(event('free', ['TRANSP:TRANSPARENT'])),
      calendar(event('cancelled', ['STATUS:CANCELLED'])),
      calendar(event('declined').replace('PARTSTAT=ACCEPTED', 'PARTSTAT=DECLINED')),
      calendar(event('kept'))
    )
    expect(events(feed)).toEqual(events(render('busy', calendar(event('kept')))))
  })

  test('gives an all-day event without DTEND the length of its DURATION', () => {
    const trip = vevent(['UID:trip', 'DTSTART;VALUE=DATE:20261121', 'DURATION:P3D', 'SUMMARY:Trip'])
    expect(events(render('busy', calendar(trip)))[0]).toContain('DTEND;VALUE=DATE:20261124')
  })

  test('gives an event without DTEND the length of its DURATION', () => {
    const timed = vevent(['UID:dur', 'DTSTART:20261120T090000Z', 'DURATION:PT2H', 'SUMMARY:Long'])
    expect(events(render('busy', calendar(timed)))[0]).toContain('DTEND:20261120T110000Z')
  })

  test('shows an all-day event as dates', () => {
    const allDay = vevent(['UID:day', 'DTSTART;VALUE=DATE:20261121', 'DTEND;VALUE=DATE:20261122', 'SUMMARY:Trip'])
    const [lines] = events(render('busy', calendar(allDay)))
    expect(lines).toContain('DTSTART;VALUE=DATE:20261121')
    expect(lines).toContain('DTEND;VALUE=DATE:20261122')
  })
})

describe('renderFeed — full details', () => {
  test('shows title, time, location, notes and guests, without reminders or the original UID', () => {
    const [lines] = events(render('full', calendar(event('a'))))
    expect(lines).toContain('SUMMARY:Title a')
    expect(lines).toContain('LOCATION:Room 1')
    expect(lines).toContain('DESCRIPTION:Notes')
    expect(lines).toContain('ATTENDEE;CN="Guest, A";PARTSTAT=NEEDS-ACTION:mailto:guest@example.com')
    expect(lines?.join('\n')).not.toContain('VALARM')
    expect(lines?.join('\n')).not.toContain('ORGANIZER')
    expect(lines?.find((l) => l.startsWith('UID:'))).toMatch(OPAQUE_UID_RE)
  })

  test('escapes text values', () => {
    const [lines] = events(render('full', calendar(event('a').replace('SUMMARY:Title a', 'SUMMARY:A\\, B\\; C'))))
    expect(lines).toContain('SUMMARY:A\\, B\\; C')
  })

  test('escapes a lone CR as a line break', () => {
    const [lines] = events(
      render('full', calendar(event('a').replace('LOCATION:Room 1', 'LOCATION:Room 1\rX-INJECTED:1')))
    )
    expect(lines).toContain('LOCATION:Room 1\\nX-INJECTED:1')
  })

  test('shows private and confidential events as busy only', () => {
    const feed = render(
      'full',
      calendar(event('private', ['CLASS:PRIVATE'])),
      calendar(event('confidential', ['CLASS:CONFIDENTIAL']))
    )
    for (const lines of events(feed)) {
      expect(lines).toContain('SUMMARY:Busy')
      expect(lines.join('\n')).not.toContain('LOCATION')
    }
    expect(events(feed)).toHaveLength(2)
  })

  test('keeps free events as free time, and drops cancelled ones', () => {
    const feed = render(
      'full',
      calendar(event('free', ['TRANSP:TRANSPARENT'])),
      calendar(event('cancelled', ['STATUS:CANCELLED']))
    )
    const shown = events(feed)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain('TRANSP:TRANSPARENT')
  })
})

describe('renderFeed — repeating events', () => {
  const series = calendar(
    vevent([
      'UID:weekly',
      'DTSTART;TZID=Europe/Berlin:20261116T100000',
      'DTEND;TZID=Europe/Berlin:20261116T110000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE;TZID=Europe/Berlin:20261123T100000',
      'SUMMARY:Standup',
    ]),
    // The third occurrence moved by two hours.
    vevent([
      'UID:weekly',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261130T100000',
      'DTSTART;TZID=Europe/Berlin:20261130T120000',
      'DTEND;TZID=Europe/Berlin:20261130T130000',
      'SUMMARY:Standup',
    ]),
    // The fourth cancelled through an override.
    vevent([
      'UID:weekly',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261207T100000',
      'DTSTART;TZID=Europe/Berlin:20261207T100000',
      'DTEND;TZID=Europe/Berlin:20261207T110000',
      'STATUS:CANCELLED',
      'SUMMARY:Standup',
    ])
  )

  test('shows every remaining occurrence in UTC, the moved one at its new time', () => {
    const starts = events(render('busy', series)).map((lines) => lines.find((l) => l.startsWith('DTSTART')))
    expect(starts).toEqual(['DTSTART:20261116T090000Z', 'DTSTART:20261130T110000Z'])
  })

  test('gives each occurrence its own stable UID', () => {
    const uids = (feed: string): (string | undefined)[] =>
      events(feed).map((lines) => lines.find((l) => l.startsWith('UID:')))
    const first = uids(render('busy', series))
    expect(new Set(first).size).toBe(2)
    expect(uids(render('busy', series))).toEqual(first)
    expect(first).not.toEqual(
      uids(
        renderFeed({
          entries: windowEntries(parseEvents(series), WINDOW),
          level: 'busy',
          name: 'Personal',
          now: NOW,
          ownerAddress: OWNER,
          shareId: 'share-2',
        })
      )
    )
  })

  test('a free override of a busy series stays hidden', () => {
    const withFreeOverride = series.replace(
      'SUMMARY:Standup\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261130T100000',
      'SUMMARY:Standup\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nTRANSP:TRANSPARENT\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261130T100000'
    )
    const starts = events(render('busy', withFreeOverride)).map((lines) => lines.find((l) => l.startsWith('DTSTART')))
    expect(starts).toEqual(['DTSTART:20261116T090000Z'])
  })

  test('a minimal override of a private series stays busy only', () => {
    const privateSeries = calendar(
      vevent([
        'UID:therapy',
        'DTSTART:20261116T090000Z',
        'DTEND:20261116T100000Z',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'CLASS:PRIVATE',
        'SUMMARY:Therapy',
        'LOCATION:Clinic',
      ]),
      // An attendee's reply to the second occurrence: no CLASS, no SUMMARY.
      vevent([
        'UID:therapy',
        'RECURRENCE-ID:20261123T090000Z',
        'DTSTART:20261123T090000Z',
        'DTEND:20261123T100000Z',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:guest@example.com',
      ])
    )
    const feed = render('full', privateSeries)
    expect(summaries(feed)).toEqual(['Busy', 'Busy', 'Busy'])
    expect(feed).not.toContain('Clinic')
  })

  test('leaves out a series it cannot expand rather than passing its rule through', () => {
    const windowsZone = calendar(
      vevent([
        'UID:outlook',
        'DTSTART;TZID=W. Europe Standard Time:20261116T100000',
        'DTEND;TZID=W. Europe Standard Time:20261116T110000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'EXDATE;TZID=W. Europe Standard Time:20261123T100000',
        'SUMMARY:Sync',
      ])
    )
    const feed = render('full', windowsZone)
    expect(feed).not.toContain('BEGIN:VEVENT')
    expect(feed).not.toContain('RRULE')
  })

  test('leaves out the unreadable overrides of a series it cannot expand too', () => {
    const windowsZone = calendar(
      vevent([
        'UID:outlook-private',
        'DTSTART;TZID=W. Europe Standard Time:20261116T100000',
        'DTEND;TZID=W. Europe Standard Time:20261116T110000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'CLASS:PRIVATE',
        'SUMMARY:Therapy',
      ]),
      vevent([
        'UID:outlook-private',
        'RECURRENCE-ID;TZID=W. Europe Standard Time:20261123T100000',
        'DTSTART;TZID=W. Europe Standard Time:20261123T120000',
        'DTEND;TZID=W. Europe Standard Time:20261123T130000',
        'SUMMARY:Therapy',
        'LOCATION:Clinic',
      ])
    )
    const feed = render('full', windowsZone)
    expect(feed).not.toContain('BEGIN:VEVENT')
  })
})
