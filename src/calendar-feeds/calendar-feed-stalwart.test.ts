// E2E for the calendar share feed against a REAL Stalwart and Postgres: a
// throwaway account's calendar is written over CalDAV, two shares of it are
// rows in the database, and each link is fetched through the MCP server's own
// routes. The credential lookup through Auth is the only stand-in: it hands
// back the account's app password, as /internal/stalwart-credential would.
//
// Skips unless STALWART_ADMIN_URL and TEST_DATABASE_URL are set. Locally,
// with the dev stack up (process-compose):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 \
//   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   bun test calendar-feed-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'

import { closeDatabaseClient, createDatabaseClient, type DatabaseClient } from '@langmail/database'
import { createCalendarShareFactory, createUserFactory } from '@langmail/database/factories'
import { calendar_shares, user } from '@langmail/database/schema'

import { type CalDavConfig, discoverAccount, putEvent } from '../caldav/client.ts'
import { createRoutes } from '../handler.ts'
import { shareCalendar } from '../tools/share-calendar.ts'
import { stopSharingCalendar } from '../tools/stop-sharing-calendar.ts'
import { createCalendarFeed, hashSecret } from './feed.ts'
import { makeCalendarFeedLiveDeps } from './live-deps.ts'
import { makeCalendarShareStore } from './shares.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const PUBLIC = 'http://mcp.test'

const adminCall = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await fetch(`${ADMIN_URL}/jmap/`, {
    body: JSON.stringify({
      methodCalls: [[method, args, '0']],
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    }),
    headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
    method: 'POST',
  })
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] }
  const [name, payload] = body.methodResponses?.[0] ?? []
  if (name === 'error' || !payload) {
    throw new Error(`${method} failed: ${JSON.stringify(body)}`)
  }
  return payload
}

const provisionAccount = async (localPart: string): Promise<{ basic: string; id: string }> => {
  const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
  const domainId = (domainQuery.ids as string[] | undefined)?.[0]
  if (!domainId) {
    throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
  }
  const created = await adminCall('x:Account/set', {
    create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
  })
  const id = (created.created as { a1?: { id?: string } } | undefined)?.a1?.id
  if (!id) {
    throw new Error(`account not created: ${JSON.stringify(created)}`)
  }
  const minted = await adminCall('x:AppPassword/set', {
    accountId: id,
    create: { ap1: { allowedIps: {}, description: 'calendar feed e2e', permissions: { '@type': 'Inherit' } } },
  })
  const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
  if (!secret) {
    throw new Error(`app password not created: ${JSON.stringify(minted)}`)
  }
  return { basic: `Basic ${Buffer.from(`${localPart}@${DOMAIN}:${secret}`).toString('base64')}`, id }
}

// 10:00Z on a Monday two weeks out, so the whole series sits in the window.
const nextMonday = (): Date => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 14 + ((8 - d.getUTCDay()) % 7))
  d.setUTCHours(10, 0, 0, 0)
  return d
}
const plusHours = (from: Date, hours: number): Date => new Date(from.getTime() + hours * 3_600_000)
const NOT_BASIC_RE = /[-:]|\.\d{3}/gu
const stamp = (at: Date): string => at.toISOString().replace(NOT_BASIC_RE, '')

const vcalendar = (...vevents: string[][]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Langmail//feed e2e//EN', ...vevents.flat(), 'END:VCALENDAR'].join(
    '\r\n'
  )
const vevent = (uid: string, start: Date, lines: string[]): string[] => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  `DTSTAMP:${stamp(new Date())}`,
  `DTSTART:${stamp(start)}`,
  `DTEND:${stamp(plusHours(start, 1))}`,
  ...lines,
  'END:VEVENT',
]

const LINK_SECRET_RE = /\/calendar-feeds\/([A-Za-z0-9_-]{43})\.ics/u

const newSecret = (): string => randomBytes(32).toString('base64url')

const summaries = (feed: string): string[] =>
  feed
    .split('\r\n')
    .filter((l) => l.startsWith('SUMMARY:'))
    .map((l) => l.slice('SUMMARY:'.length))
const starts = (feed: string): string[] => feed.split('\r\n').filter((l) => l.startsWith('DTSTART'))

describe.skipIf(!(ADMIN_URL && TEST_DATABASE_URL))('calendar share feed against Stalwart', () => {
  const localPart = `feed-e2e-${Date.now()}`
  const busySecret = newSecret()
  const fullSecret = newSecret()
  const monday = nextMonday()
  let accountId: string
  let basic: string
  let calendarUrl: string
  let caldav: CalDavConfig
  let db: DatabaseClient
  let userId: string
  let fetchFeed: (secret: string) => Promise<string>

  beforeAll(async () => {
    const account = await provisionAccount(localPart)
    accountId = account.id
    basic = account.basic
    caldav = { authHeaders: () => ({ authorization: basic }), serverUrl: ADMIN_URL as string }
    const discovery = await discoverAccount(caldav, 'unused')
    if (!discovery.defaultCalendarUrl) {
      throw new Error('no default calendar discovered')
    }
    calendarUrl = discovery.defaultCalendarUrl

    const put = (ical: string) => putEvent(caldav, { calendarUrl, ical, token: 'unused' })
    await put(vcalendar(vevent('busy-1', plusHours(monday, -48), ['SUMMARY:Dentist', 'LOCATION:Main St 1'])))
    await put(vcalendar(vevent('free-1', plusHours(monday, -47), ['SUMMARY:Focus time', 'TRANSP:TRANSPARENT'])))
    await put(vcalendar(vevent('private-1', plusHours(monday, -46), ['SUMMARY:Therapy', 'CLASS:PRIVATE'])))
    // Weekly ×4: the second occurrence cancelled (EXDATE), the third moved two hours later.
    await put(
      vcalendar(
        vevent('weekly-1', monday, [
          'SUMMARY:Standup',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          `EXDATE:${stamp(plusHours(monday, 7 * 24))}`,
        ]),
        vevent('weekly-1', plusHours(monday, 14 * 24 + 2), [
          'SUMMARY:Standup',
          `RECURRENCE-ID:${stamp(plusHours(monday, 14 * 24))}`,
        ])
      )
    )

    db = createDatabaseClient(TEST_DATABASE_URL as string)
    const owner = await createUserFactory(db).create()
    userId = owner.id
    const shares = createCalendarShareFactory(db)
    // Stored decoded (`@`, where Stalwart's hrefs say `%40`): the lookup must
    // match the calendar however its path is escaped.
    const path = decodeURIComponent(new URL(calendarUrl, ADMIN_URL).pathname)
    await shares.create({ calendar_url: path, level: 'busy', secret_hash: hashSecret(busySecret), user_id: userId })
    await shares.create({ calendar_url: path, level: 'full', secret_hash: hashSecret(fullSecret), user_id: userId })

    const live = makeCalendarFeedLiveDeps({
      authService: { baseUrl: 'http://unused', internalToken: 'unused' },
      db,
      stalwartUrl: ADMIN_URL as string,
    })
    const routes = createRoutes({
      authIssuer: 'http://auth.test/api/auth',
      calendarFeed: createCalendarFeed({
        ...live,
        findCredential: (id) =>
          Promise.resolve(id === userId ? { address: `${localPart}@${DOMAIN}`, authorization: basic } : null),
      }),
      observability: () => ({ activityRecording: false, errorTracking: false, logShipping: false }),
      publicUrl: PUBLIC,
      stalwartUrl: ADMIN_URL as string,
    })
    fetchFeed = async (secret) => {
      const res = await routes.fetch(new Request(`${PUBLIC}/calendar-feeds/${secret}.ics`))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
      return res.text()
    }
  })

  afterAll(async () => {
    if (db) {
      await db.delete(user).where(inArray(user.id, userId ? [userId] : []))
      await closeDatabaseClient(db)
    }
    if (accountId) {
      await adminCall('x:Account/set', { destroy: [accountId] })
    }
  })

  test('busy only: busy times titled Busy, no free time, no details', async () => {
    const feed = await fetchFeed(busySecret)
    expect(summaries(feed)).toEqual(['Busy', 'Busy', 'Busy', 'Busy', 'Busy'])
    for (const hidden of ['Dentist', 'Main St', 'Therapy', 'Standup', 'Focus', 'weekly-1', 'busy-1']) {
      expect(feed).not.toContain(hidden)
    }
  })

  test('full details: titles and location, private as busy, free as free time', async () => {
    const feed = await fetchFeed(fullSecret)
    expect(summaries(feed)).toEqual(['Dentist', 'Focus time', 'Busy', 'Standup', 'Standup', 'Standup'])
    expect(feed).toContain('LOCATION:Main St 1')
    expect(feed).not.toContain('Therapy')
  })

  test('repeating: every occurrence, the moved one at its new time, the cancelled one gone', async () => {
    const feed = await fetchFeed(fullSecret)
    const series = [monday, plusHours(monday, 14 * 24 + 2), plusHours(monday, 21 * 24)].map(
      (at) => `DTSTART:${stamp(at)}`
    )
    expect(starts(feed).filter((s) => series.includes(s))).toEqual(series)
    expect(starts(feed)).not.toContain(`DTSTART:${stamp(plusHours(monday, 7 * 24))}`)
    expect(starts(feed)).not.toContain(`DTSTART:${stamp(plusHours(monday, 14 * 24))}`)
  })

  test('live: a new event shows on the next fetch', async () => {
    await putEvent(caldav, {
      calendarUrl,
      ical: vcalendar(vevent('late-1', plusHours(monday, 30), ['SUMMARY:Added later'])),
      token: 'unused',
    })
    expect(summaries(await fetchFeed(fullSecret))).toContain('Added later')
  })

  test('a stopped share shows an empty calendar, like an unknown link; the other share keeps serving', async () => {
    const unknown = await fetchFeed(newSecret())
    await db.delete(calendar_shares).where(eq(calendar_shares.secret_hash, hashSecret(busySecret)))
    const stopped = await fetchFeed(busySecret)
    expect(stopped).not.toContain('BEGIN:VEVENT')
    expect(stopped).toBe(unknown)
    expect(summaries(await fetchFeed(fullSecret))).toContain('Dentist')
  })

  test('share_calendar mints a link that serves the feed; stop_sharing_calendar empties it', async () => {
    const deps = {
      listCalendars: async () => [{ displayName: 'Personal', url: new URL(calendarUrl, ADMIN_URL).href }],
      publicUrl: PUBLIC,
      shares: makeCalendarShareStore(db),
    }
    const shared = await shareCalendar(deps, {
      args: { calendar: 'Personal', level: 'busy', with: 'Sam' },
      token: 'unused',
      userId,
    })
    const secret = LINK_SECRET_RE.exec(shared.content[0]?.text ?? '')?.[1] ?? ''
    expect(secret).not.toBe('')
    expect(summaries(await fetchFeed(secret))).toContain('Busy')
    expect(await fetchFeed(secret)).not.toContain('Dentist')

    await shareCalendar(deps, { args: { calendar: 'Personal', level: 'full', with: 'sam' }, token: 'unused', userId })
    expect(summaries(await fetchFeed(secret))).toContain('Dentist')

    const stopped = await stopSharingCalendar(deps, { args: { with: 'Sam' }, token: 'unused', userId })
    expect(stopped.isError).toBeUndefined()
    expect(await fetchFeed(secret)).not.toContain('BEGIN:VEVENT')
    expect(summaries(await fetchFeed(fullSecret))).toContain('Dentist')
  })

  test("the sharing tools change only the caller's shares", async () => {
    const other = await createUserFactory(db).create()
    try {
      const path = new URL(calendarUrl, ADMIN_URL).pathname
      const theirs = await createCalendarShareFactory(db).create({
        calendar_url: path,
        label: 'Sam',
        level: 'busy',
        user_id: other.id,
      })
      const deps = {
        listCalendars: async () => [{ displayName: 'Personal', url: new URL(calendarUrl, ADMIN_URL).href }],
        publicUrl: PUBLIC,
        shares: makeCalendarShareStore(db),
      }
      await shareCalendar(deps, { args: { calendar: 'Personal', level: 'busy', with: 'Sam' }, token: 'unused', userId })
      await shareCalendar(deps, { args: { calendar: 'Personal', level: 'full', with: 'Sam' }, token: 'unused', userId })
      await stopSharingCalendar(deps, { args: { with: 'Sam' }, token: 'unused', userId })
      const [row] = await db.select().from(calendar_shares).where(eq(calendar_shares.id, theirs.id))
      expect(row?.level).toBe('busy')
    } finally {
      await db.delete(user).where(eq(user.id, other.id))
    }
  })
})
