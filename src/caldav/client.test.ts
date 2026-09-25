import { describe, expect, test } from 'bun:test'

import {
  findEventObject,
  isEmptyCollectionError,
  isTimeoutError,
  moveEvent,
  newEventResourceName,
  pickDefaultCalendar,
  pickOrganizer,
  putEvent,
  updateCalendar,
  withTrailingSlash,
} from './client.ts'
import { buildInvite } from './ical.ts'
import { type CalendarObject, type CalendarSummary } from './types.ts'

const cal = (url: string, displayName = ''): CalendarSummary => ({ displayName, url })

const ELEMENT_PREFIX_RE = /<\/?([a-z]+):/gu
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

// PROPPATCH answers 207 even when it refuses a property; the refusal sits in a
// per-property propstat, which tsdav drops without failing the response. The
// loopback server lets each test choose that propstat status.
describe('updateCalendar', () => {
  const multistatus = (propStatus: string): string =>
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:multistatus xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">' +
    '<d:response><d:href>/dav/cal/u/default/</d:href>' +
    `<d:propstat><d:prop><d:displayname/><a:calendar-color/></d:prop><d:status>${propStatus}</d:status></d:propstat>` +
    '</d:response></d:multistatus>'

  const withServer = async (
    reply: { body: string; status: number },
    run: (base: string) => Promise<void>
  ): Promise<{ body: string; method: string }> => {
    const seen = { body: '', method: '' }
    const server = Bun.serve({
      fetch: async (req) => {
        seen.method = req.method
        seen.body = await req.text()
        return new Response(reply.body, {
          headers: { 'content-type': 'application/xml; charset=utf-8' },
          status: reply.status,
        })
      },
      port: 0,
    })
    try {
      await run(`http://127.0.0.1:${server.port}`)
      return seen
    } finally {
      await server.stop(true)
    }
  }

  const xml = (body: string, status = 207): { body: string; status: number } => ({ body, status })

  test('PROPPATCHes the display name and color', async () => {
    const seen = await withServer(xml(multistatus('HTTP/1.1 200 OK')), (base) =>
      updateCalendar(
        { serverUrl: base },
        { color: '#2E6FD8', name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` }
      )
    )

    expect(seen.method).toBe('PROPPATCH')
    expect(seen.body).toContain('Business</')
    expect(seen.body).toContain('calendar-color')
    expect(seen.body).toContain('#2E6FD8')
  })

  test('declares every namespace prefix the body uses', async () => {
    const seen = await withServer(xml(multistatus('HTTP/1.1 200 OK')), (base) =>
      updateCalendar(
        { serverUrl: base },
        { color: '#2E6FD8', name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` }
      )
    )

    // An unbound prefix is malformed XML; Stalwart answers it with 400.
    const used = new Set([...seen.body.matchAll(ELEMENT_PREFIX_RE)].map((m) => m[1]))
    for (const prefix of used) {
      expect(seen.body).toContain(`xmlns:${prefix}=`)
    }
  })

  test('sends only the properties that change', async () => {
    const seen = await withServer(xml(multistatus('HTTP/1.1 200 OK')), (base) =>
      updateCalendar({ serverUrl: base }, { name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` })
    )

    expect(seen.body).toContain('displayname')
    expect(seen.body).not.toContain('calendar-color')
  })

  test('throws when the server refuses a property inside a 207', async () => {
    let caught: unknown
    await withServer(xml(multistatus('HTTP/1.1 403 Forbidden')), async (base) => {
      caught = await updateCalendar(
        { serverUrl: base },
        { name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` }
      ).catch((err: unknown) => err)
    })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('403')
  })

  // What an RFC 4918 server sends when it refuses one property: that one 403,
  // the rest 424 Failed Dependency, since PROPPATCH is all-or-nothing.
  test('names each refused status once when the reply mixes success and failure', async () => {
    const mixed =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:multistatus xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">' +
      '<d:response><d:href>/dav/cal/u/default/</d:href>' +
      '<d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 424 Failed Dependency</d:status></d:propstat>' +
      '<d:propstat><d:prop><a:calendar-color/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat>' +
      '</d:response></d:multistatus>'
    let caught: unknown
    await withServer(xml(mixed), async (base) => {
      caught = await updateCalendar(
        { serverUrl: base },
        { color: '#2E6FD8', name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` }
      ).catch((err: unknown) => err)
    })

    const message = (caught as Error).message
    expect(message).toContain('424 Failed Dependency')
    expect(message.match(/403 Forbidden/gu)).toHaveLength(1)
  })

  test('throws when a 207 confirms no property at all', async () => {
    const bare =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/cal/u/default/</d:href>' +
      '<d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>'
    let caught: unknown
    await withServer(xml(bare), async (base) => {
      caught = await updateCalendar(
        { serverUrl: base },
        { name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` }
      ).catch((err: unknown) => err)
    })

    expect(caught).toBeInstanceOf(Error)
  })

  test('accepts a bare 200 with no multistatus body as applied', async () => {
    let caught: unknown = 'none'
    await withServer({ body: '', status: 200 }, async (base) => {
      caught = await updateCalendar(
        { serverUrl: base },
        { name: 'Business', token: 'tok', url: `${base}/dav/cal/u/default/` }
      ).catch((err: unknown) => err)
    })

    expect(caught).toBeUndefined()
  })

  test('throws when the whole request is refused', async () => {
    let caught: unknown
    await withServer({ body: '', status: 404 }, async (base) => {
      caught = await updateCalendar(
        { serverUrl: base },
        { name: 'Business', token: 'tok', url: `${base}/dav/cal/u/gone/` }
      ).catch((err: unknown) => err)
    })

    expect((caught as Error).message).toContain('404')
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

// The MOVE move_calendar_events sends, and how each reply Stalwart gives
// (stalwart-move-event.test.ts pins those replies) maps to an outcome.
describe('moveEvent', () => {
  const NO_UID_CONFLICT =
    '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav">' +
    '<A:no-uid-conflict><D:href>/dav/cal/u/private/other.ics</D:href></A:no-uid-conflict></D:error>'

  const withServer = async (reply: { body: string; status: number }) => {
    const seen = { destination: '', method: '', overwrite: '', path: '' }
    const server = Bun.serve({
      fetch: (req) => {
        seen.method = req.method
        seen.path = new URL(req.url).pathname
        seen.destination = req.headers.get('destination') ?? ''
        seen.overwrite = req.headers.get('overwrite') ?? ''
        return new Response(reply.body, {
          headers: reply.body ? { 'content-type': 'application/xml; charset=utf-8' } : {},
          status: reply.status,
        })
      },
      port: 0,
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const outcome = await moveEvent(
        { serverUrl: base },
        {
          destination: `${base}/dav/cal/u/private/probe@example.com.ics`,
          token: 'tok',
          url: `${base}/dav/cal/u/default/probe@example.com.ics`,
        }
      )
      return { base, outcome, seen }
    } finally {
      await server.stop(true)
    }
  }

  test('sends MOVE with the destination verbatim and Overwrite: F', async () => {
    const { base, outcome, seen } = await withServer({ body: '', status: 201 })
    expect(outcome).toEqual({ kind: 'moved' })
    expect(seen.method).toBe('MOVE')
    expect(seen.path).toBe('/dav/cal/u/default/probe@example.com.ics')
    expect(seen.destination).toBe(`${base}/dav/cal/u/private/probe@example.com.ics`)
    expect(seen.overwrite).toBe('F')
  })

  test('maps 204 to moved', async () => {
    expect((await withServer({ body: '', status: 204 })).outcome).toEqual({ kind: 'moved' })
  })

  test('tells the two 412s apart by body', async () => {
    expect((await withServer({ body: NO_UID_CONFLICT, status: 412 })).outcome).toEqual({ kind: 'uidConflict' })
    expect((await withServer({ body: '', status: 412 })).outcome).toEqual({ kind: 'nameConflict' })
  })

  test('maps 403 to forbidden and anything else to failed with its status', async () => {
    expect((await withServer({ body: '', status: 403 })).outcome).toEqual({ kind: 'forbidden' })
    expect((await withServer({ body: '', status: 409 })).outcome).toEqual({ kind: 'failed', status: 409 })
  })
})

describe('isTimeoutError', () => {
  test('recognises the error AbortSignal.timeout raises', async () => {
    const signal = AbortSignal.timeout(0)
    await Bun.sleep(5)
    const err = await fetch('http://127.0.0.1:9', { signal }).catch((e: unknown) => e)
    expect(isTimeoutError(err)).toBe(true)
  })

  test('does not treat other errors as timeouts', () => {
    expect(isTimeoutError(new Error('boom'))).toBe(false)
    expect(isTimeoutError('TimeoutError')).toBe(false)
  })
})
