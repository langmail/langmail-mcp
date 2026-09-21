import { describe, expect, test } from 'bun:test'

import {
  findEventObject,
  isEmptyCollectionError,
  newEventResourceName,
  pickDefaultCalendar,
  pickOrganizer,
  putEvent,
  withTrailingSlash,
} from './client.ts'
import { buildInvite } from './ical.ts'
import { type CalendarObject, type CalendarSummary } from './types.ts'

const cal = (url: string, displayName = ''): CalendarSummary => ({ displayName, url })

const UUID_ICS_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ics$/u

describe('pickDefaultCalendar', () => {
  test('prefers a /default/ collection', () => {
    const cals = [cal('https://m/dav/cal/u/work/'), cal('https://m/dav/cal/u/default/')]
    expect(pickDefaultCalendar(cals)).toBe('https://m/dav/cal/u/default/')
  })

  test('falls back to the first calendar when none is /default/', () => {
    const cals = [cal('https://m/dav/cal/u/work/'), cal('https://m/dav/cal/u/home/')]
    expect(pickDefaultCalendar(cals)).toBe('https://m/dav/cal/u/work/')
  })

  test('matches a /default collection without a trailing slash', () => {
    const cals = [cal('https://m/dav/cal/u/work/'), cal('https://m/dav/cal/u/default')]
    expect(pickDefaultCalendar(cals)).toBe('https://m/dav/cal/u/default')
  })

  test('returns null for an empty list', () => {
    expect(pickDefaultCalendar([])).toBeNull()
  })
})

describe('withTrailingSlash', () => {
  test('appends a slash when missing', () => {
    expect(withTrailingSlash('https://m/dav/cal/u/team')).toBe('https://m/dav/cal/u/team/')
  })

  test('leaves an already-slashed url unchanged', () => {
    expect(withTrailingSlash('https://m/dav/cal/u/team/')).toBe('https://m/dav/cal/u/team/')
  })
})

describe('pickOrganizer', () => {
  test('strips the mailto: prefix from the first address', () => {
    expect(pickOrganizer(['mailto:host@langmail.me'])).toBe('host@langmail.me')
  })

  test('prefers the mailto: address when a principal URL is listed first', () => {
    expect(pickOrganizer(['/dav/pal/host%40langmail.me/', 'mailto:host@langmail.me'])).toBe('host@langmail.me')
  })

  test('returns null when no mailto: address is present', () => {
    expect(pickOrganizer(['/dav/pal/host%40langmail.me/'])).toBeNull()
  })

  test('returns null when there are no addresses', () => {
    expect(pickOrganizer([])).toBeNull()
  })
})

describe('newEventResourceName', () => {
  // The bug this replaced: we named the `.ics` after the event UID, our UIDs
  // carried a domain, and since Stalwart 0.16.19 the `@` is stored verbatim
  // rather than percent-encoded — which makes the resource invisible in Apple
  // Calendar and iOS Calendar. A UUID has no `@` and needs no encoding, which
  // this single assertion covers; see putEvent below for the guard that the
  // name is actually what reaches the wire.
  test('is a bare UUID with an .ics extension, so it leaks nothing from the object', () => {
    expect(newEventResourceName()).toMatch(UUID_ICS_RE)
  })
})

// The fix site itself: `putEvent` must name the resource from
// `newEventResourceName`, never from anything inside the payload. The
// createCalendarEvent unit tests mock `deps.putEvent` away and so cannot see
// the filename, and the live-server assertion in caldav-integration.test.ts
// runs only when CALDAV_* is set — so without this, re-deriving the filename
// from the UID would pass the whole default `bun test` run.
//
// The request is captured with a loopback server rather than by stubbing
// `fetch`: tsdav binds `globalThis.fetch` at module load, so a later
// reassignment never reaches it, and mock.module is process-wide for the whole
// test run (see handler.logging.test.ts). A real server keeps tsdav's own URL
// building — the part that turns a filename into an href — inside the path
// under test.
describe('putEvent', () => {
  const UID = 'legacy-uid-9f3c@mail.example.com'

  const capturePutUrl = async (): Promise<string> => {
    let path = ''
    const server = Bun.serve({
      fetch: (req) => {
        path = new URL(req.url).pathname
        return new Response('', { status: 201 })
      },
      port: 0,
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      await putEvent(
        { serverUrl: base },
        {
          calendarUrl: `${base}/dav/cal/u/default/`,
          ical: buildInvite({
            attendees: ['guest@example.com'],
            end: new Date('2026-06-12T10:30:00Z'),
            organizer: 'host@langmail.me',
            start: new Date('2026-06-12T10:00:00Z'),
            title: 'Sync',
            uid: UID,
          }),
          token: 'tok',
        }
      )
      return path
    } finally {
      await server.stop(true)
    }
  }

  test('PUTs to a generated UUID name, not to anything derived from the payload', async () => {
    const path = await capturePutUrl()
    const name = path.slice(path.lastIndexOf('/') + 1)

    expect(name).toMatch(UUID_ICS_RE)
    // The UID in the payload carries a domain; none of it may reach the href.
    expect(path).not.toContain('@')
    expect(path).not.toContain('%40')
    expect(path).not.toContain('legacy-uid-9f3c')
    expect(path).not.toContain('mail.example.com')
  })

  test('names two PUTs of the same payload differently', async () => {
    expect(await capturePutUrl()).not.toBe(await capturePutUrl())
  })
})

describe('findEventObject', () => {
  const obj = (uid: string, url: string): CalendarObject => ({
    data: buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: 'host@langmail.me',
      start: new Date('2026-06-12T10:00:00Z'),
      title: 'Sync',
      uid,
    }),
    url,
  })

  test('matches on the iCalendar UID even when the filename differs', () => {
    // Server-assigned filename ("abc123.ics") bears no relation to the UID.
    const stored = obj('evt-1@langmail.me', 'https://m/dav/cal/u/default/abc123.ics')
    const found = findEventObject(
      [obj('other@langmail.me', 'https://m/dav/cal/u/default/x.ics'), stored],
      'evt-1@langmail.me'
    )
    expect(found?.url).toBe('https://m/dav/cal/u/default/abc123.ics')
  })

  test('returns null when no object carries the UID', () => {
    expect(
      findEventObject([obj('a@langmail.me', 'https://m/dav/cal/u/default/a.ics')], 'missing@langmail.me')
    ).toBeNull()
  })
})

describe('isEmptyCollectionError', () => {
  test('matches the 404 tsdav throws over an empty collection', () => {
    // Verbatim shape of the error Stalwart + tsdav produce for an empty calendar.
    const err = new Error('Collection query failed: 404 Not Found. Raw response: [object Object]')
    expect(isEmptyCollectionError(err)).toBe(true)
  })

  test('does not swallow other collection-query failures', () => {
    expect(isEmptyCollectionError(new Error('Collection query failed: 500 Internal Server Error.'))).toBe(false)
    expect(isEmptyCollectionError(new Error('Collection query failed: 403 Forbidden.'))).toBe(false)
  })

  test('does not match unrelated errors or non-errors', () => {
    expect(isEmptyCollectionError(new Error('network unreachable'))).toBe(false)
    expect(isEmptyCollectionError('Collection query failed: 404')).toBe(false)
  })
})
