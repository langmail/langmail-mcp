// E2E for the organizer-preservation fix in update_calendar_event against a
// REAL Stalwart — the one behaviour Radicale can't verify: Stalwart's PUT
// validation rejects an object whose components carry different ORGANIZERs
// with 412 `SameOrganizerInAllComponents`. That is exactly what the tool used
// to produce when editing an event created under a previous account address
// (still an enabled alias): it stamped the freshly discovered principal onto
// the rebuilt component while the stored master kept the old alias.
//
// The test provisions a throwaway account with an alias on the dev Stalwart
// (raw admin JMAP — the same x:-method contract services/auth uses), seeds a
// recurring event whose ORGANIZER is the address discovery does NOT return,
// then drives the real tool (live deps, CalDAV all the way) through both edit
// modes and asserts the stored organizer survives.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-update-organizer

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

// Minimal admin JMAP call (x:-prefixed management methods; see
// services/auth/src/stalwart/admin-client.ts for the full contract).
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

// 10:00Z on a Tuesday comfortably in the future, so Stalwart treats the
// series as schedulable and the run date never catches up with it.
const nextTuesday = (): Date => {
  const d = new Date()
  // Days until the next Tuesday (day 2), plus four full weeks of headroom
  // (a multiple of 7, so the weekday is preserved).
  d.setUTCDate(d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(10, 0, 0, 0)
  return d
}

const hoursLater = (from: Date, hours: number): Date => new Date(from.getTime() + hours * 3_600_000)

live('update_calendar_event against live Stalwart — stored ORGANIZER survives edits', () => {
  const run = Date.now()
  const localPart = `mcp-e2e-${run}`
  const aliasPart = `${localPart}-old`
  let accountId: string
  let cfg: CalDavConfig
  let calendarUrl: string
  // The account address the tool would wrongly stamp (discovery result) and
  // the one the seeded events actually carry.
  let discovered: string
  let storedOrganizer: string

  beforeAll(async () => {
    // Domain (idempotent — CI boots a bootstrapped server, local dev keeps one).
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }

    // Account + retained-previous-address alias, the exact shape renameAccount
    // leaves behind in production.
    const created = await adminCall('x:Account/set', {
      create: {
        a1: {
          '@type': 'User',
          aliases: { 0: { description: 'previous address', domainId, enabled: true, name: aliasPart } },
          domainId,
          name: localPart,
          roles: { '@type': 'User' },
        },
      },
    })
    const account = (created.created as { a1?: { id?: string } } | undefined)?.a1
    if (!account?.id) {
      throw new Error(`account not created: ${JSON.stringify(created)}`)
    }
    accountId = account.id

    // App password — the credential that authenticates Basic over HTTP/DAV.
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
    discovered = discovery.organizer
    // Seed with whichever of the two account addresses discovery does NOT
    // return, so the stored ORGANIZER genuinely differs from what the tool
    // would stamp — the production shape after an address change.
    const primary = `${localPart}@${DOMAIN}`
    const alias = `${aliasPart}@${DOMAIN}`
    storedOrganizer = discovered === alias ? primary : alias
    expect(storedOrganizer).not.toBe(discovered)
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its calendar data.
    if (accountId) {
      await adminCall('x:Account/set', { destroy: [accountId] })
    }
  })

  test('occurrence edit PUTs an override that Stalwart accepts and keeps the stored ORGANIZER', async () => {
    const uid = `organizer-occurrence-${run}@mcp-e2e`
    const start = nextTuesday()
    await putEvent(cfg, {
      calendarUrl,
      ical: buildInvite({
        attendees: ['guest@example.com'],
        end: hoursLater(start, 0.5),
        organizer: storedOrganizer,
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        start,
        title: 'Weekly sync',
        uid,
      }),
      token: TOKEN,
      uid,
    })

    const occurrence = new Date(start.getTime() + 7 * 86_400_000)
    const result = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: {
        attendees: ['guest@example.com'],
        end: hoursLater(occurrence, 2.5).toISOString(),
        recurrenceId: occurrence.toISOString(),
        start: hoursLater(occurrence, 2).toISOString(),
        title: 'Weekly sync (moved)',
        uid,
      },
      token: TOKEN,
    })

    // Pre-fix this PUT died with `caldav PUT returned 412`
    // (SameOrganizerInAllComponents) before any result came back.
    expect(result.isError).toBeUndefined()

    const stored = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(stored).not.toBeNull()
    const events = parseEvents(stored?.data ?? '')
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.organizer)).toEqual([storedOrganizer, storedOrganizer])
  })

  test('full edit keeps the stored ORGANIZER instead of re-stamping the discovered principal', async () => {
    const uid = `organizer-full-${run}@mcp-e2e`
    const start = nextTuesday()
    await putEvent(cfg, {
      calendarUrl,
      ical: buildInvite({
        attendees: ['guest@example.com'],
        end: hoursLater(start, 1),
        organizer: storedOrganizer,
        start,
        title: 'One-off',
        uid,
      }),
      token: TOKEN,
      uid,
    })

    const result = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: {
        attendees: ['guest@example.com'],
        end: hoursLater(start, 3).toISOString(),
        start: hoursLater(start, 2).toISOString(),
        title: 'One-off (moved)',
        uid,
      },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    const stored = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(stored).not.toBeNull()
    const events = parseEvents(stored?.data ?? '')
    expect(events).toHaveLength(1)
    expect(events[0]?.organizer).toBe(storedOrganizer)
    expect(events[0]?.organizer).not.toBe(discovered)
  })
})
