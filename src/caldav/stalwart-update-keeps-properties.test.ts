// E2E for issue #946 against a REAL Stalwart: update_calendar_event keeps the
// properties it does not model. Before the fix the whole-event rebuild wrote
// only what buildInvite knows, so CATEGORIES, CLASS, URL, TRANSP and X-
// properties vanished on every edit. The tool now carries them over from the
// stored VEVENT (caldav/occurrence.ts carryStoredProperties).
//
// It provisions one throwaway account on the dev Stalwart (raw admin JMAP),
// seeds an event with an external attendee carrying VALARM, CATEGORIES,
// CLASS, URL, TRANSP and an X- property, edits its title and then its time
// through the real tool (live deps), and reads it back after each edit.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-update-keeps-properties
//
// NB: live test files only run in CI when they are listed in the `test:stalwart`
// script in services/mcp/package.json — an unlisted file silently never runs.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { parseEvents } from '@langmail/ical'

import { makeLiveDeps, updateCalendarEvent } from '../tools/update-calendar-event.ts'
import { type CalDavConfig, discoverAccount, fetchEvent, putEvent } from './client.ts'
import { buildInvite } from './ical.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — cfg.authHeaders carries Basic auth

const live = ADMIN_URL ? describe : describe.skip

const adminCall = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await fetch(`${ADMIN_URL}/jmap/`, {
    body: JSON.stringify({
      methodCalls: [[method, args, '0']],
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    }),
    headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
    method: 'POST',
  })
  if (res.status !== 200) {
    throw new Error(`${method} returned HTTP ${res.status}`)
  }
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] }
  const [name, payload] = body.methodResponses?.[0] ?? []
  if (name === 'error' || !payload) {
    throw new Error(`${method} failed: ${JSON.stringify(body)}`)
  }
  return payload
}

// 10:00Z four weeks out, so Stalwart treats the event as schedulable.
const inFourWeeks = (): Date => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 28)
  d.setUTCHours(10, 0, 0, 0)
  return d
}

const hoursLater = (from: Date, hours: number): Date => new Date(from.getTime() + hours * 3_600_000)

const KEPT = [
  'CATEGORIES:Work,Planning',
  'CLASS:PRIVATE',
  'URL:https://example.com/agenda',
  'TRANSP:TRANSPARENT',
  'X-ACME-NOTE:kept across edits',
]
const ALARM = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Planning', 'END:VALARM']

const LINE_BREAK_RE = /\r?\n/u
const unfold = (ical: string): string => ical.replace(/\r\n[ \t]/gu, '')

// The stored VEVENT keeps every seeded property, value for value. Stalwart may
// re-serialize, so each is looked up by its whole unfolded line.
const expectKept = (ical: string): void => {
  const lines = unfold(ical).split(LINE_BREAK_RE)
  for (const line of KEPT) {
    expect(lines).toContain(line)
  }
  expect(lines).toContain('BEGIN:VALARM')
  expect(lines).toContain('TRIGGER:-PT15M')
}

live('update_calendar_event against live Stalwart — unmodelled properties survive edits', () => {
  const run = Date.now()
  const localPart = `mcp-e2e-props-${run}`
  let accountId: string
  let cfg: CalDavConfig
  let calendarUrl: string
  let organizer: string

  beforeAll(async () => {
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
    accountId = id
    const minted = await adminCall('x:AppPassword/set', {
      accountId,
      create: { ap1: { allowedIps: {}, description: 'mcp e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    const basic = `Basic ${Buffer.from(`${localPart}@${DOMAIN}:${secret}`).toString('base64')}`
    cfg = { authHeaders: () => ({ authorization: basic }), serverUrl: ADMIN_URL as string }
    const discovery = await discoverAccount(cfg, TOKEN)
    if (!(discovery.defaultCalendarUrl && discovery.organizer)) {
      throw new Error(`discovery incomplete: ${JSON.stringify(discovery)}`)
    }
    calendarUrl = discovery.defaultCalendarUrl
    organizer = discovery.organizer
  })

  afterAll(async () => {
    if (accountId) {
      await adminCall('x:Account/set', { destroy: [accountId] })
    }
  })

  test('a title edit and then a time move keep VALARM, CATEGORIES, CLASS, URL, TRANSP and an X- property', async () => {
    const uid = `keeps-properties-${run}`
    const start = inFourWeeks()
    const seeded = buildInvite({
      attendees: ['guest@example.com'],
      end: hoursLater(start, 1),
      organizer,
      start,
      title: 'Planning',
      uid,
    }).replace('END:VEVENT', () => [...KEPT, ...ALARM, 'END:VEVENT'].join('\r\n'))
    await putEvent(cfg, { calendarUrl, ical: seeded, token: TOKEN })
    const before = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expectKept(before?.data ?? '')

    const retitled = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: { notify: 'none', title: 'Planning (renamed)', uid },
      token: TOKEN,
    })
    expect(retitled.isError).toBeUndefined()
    const afterTitle = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(parseEvents(afterTitle?.data ?? '')[0]?.title).toBe('Planning (renamed)')
    expectKept(afterTitle?.data ?? '')

    const moved = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: { notify: 'none', start: hoursLater(start, 2).toISOString(), uid },
      token: TOKEN,
    })
    expect(moved.isError).toBeUndefined()
    const afterMove = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    const events = parseEvents(afterMove?.data ?? '')
    expect(events).toHaveLength(1)
    expect(Date.parse(events[0]?.start ?? '')).toBe(hoursLater(start, 2).getTime())
    expectKept(afterMove?.data ?? '')
  })
})
