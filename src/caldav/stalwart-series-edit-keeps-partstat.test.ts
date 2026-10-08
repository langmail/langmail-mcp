// E2E for issue #837 against a REAL Stalwart: a detail edit of a series made
// through update_calendar_event keeps every attendee's reply (RFC 5546
// §3.2.2.2), and only a reschedule asks them to answer again.
//
// Before the fix, the whole-series rebuild wrote every ATTENDEE back as
// PARTSTAT=NEEDS-ACTION. Stalwart then saw changed attendee parameters, bumped
// SEQUENCE a second time (0 → 2) and sent a REQUEST carrying NEEDS-ACTION,
// which reset the attendee's own copy too.
//
// It provisions two throwaway accounts on the dev Stalwart (raw admin JMAP —
// the same x:-method contract services/auth uses): an organizer and a LOCAL
// attendee. The organizer seeds a weekly series; the attendee accepts it by
// flipping the PARTSTAT in their own copy, which Stalwart turns into a REPLY
// merged into the organizer's copy. Then the real update tool (live deps) edits
// only the description, and later moves the start.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-series-edit-keeps-partstat
//
// NB: live test files only run in CI when they are listed in the `test:stalwart`
// script in services/mcp/package.json — an unlisted file silently never runs.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { parseEvents } from '@langmail/ical'

import { makeLiveDeps, updateCalendarEvent } from '../tools/update-calendar-event.ts'
import { type CalDavConfig, discoverAccount, fetchEvent, putEvent } from './client.ts'
import { buildInvite, parseSequence } from './ical.ts'

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

interface Principal {
  addr: string
  basic: string
  cfg: CalDavConfig
  defaultUrl: string
  organizer: string
}

const provision = async (localPart: string, domainId: string, created: string[]): Promise<Principal> => {
  const made = await adminCall('x:Account/set', {
    create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
  })
  const id = (made.created as { a1?: { id?: string } } | undefined)?.a1?.id
  if (!id) {
    throw new Error(`account not created: ${JSON.stringify(made)}`)
  }
  created.push(id)
  const minted = await adminCall('x:AppPassword/set', {
    accountId: id,
    create: { ap1: { allowedIps: {}, description: 'mcp keeps-partstat e2e', permissions: { '@type': 'Inherit' } } },
  })
  const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
  if (!secret) {
    throw new Error(`app password not created: ${JSON.stringify(minted)}`)
  }
  const addr = `${localPart}@${DOMAIN}`
  const basic = `Basic ${Buffer.from(`${addr}:${secret}`).toString('base64')}`
  const cfg: CalDavConfig = { authHeaders: () => ({ authorization: basic }), serverUrl: ADMIN_URL as string }
  const discovery = await discoverAccount(cfg, TOKEN)
  if (!(discovery.defaultCalendarUrl && discovery.organizer)) {
    throw new Error(`discovery incomplete: ${JSON.stringify(discovery)}`)
  }
  return { addr, basic, cfg, defaultUrl: discovery.defaultCalendarUrl, organizer: discovery.organizer }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 10:00Z on a Tuesday comfortably in the future, so Stalwart treats the series
// as schedulable and the run date never catches up with it.
const nextTuesday = (): Date => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(10, 0, 0, 0)
  return d
}

const PARTSTAT_RE = /PARTSTAT=[A-Z-]+/u
const FOLD_RE = /\r?\n[ \t]/gu
const NEWLINE_RE = /\r?\n/u

// Polls the principal's copy of `uid` until `done` holds, returning the last
// raw object either way (null when it never arrived).
const copyUntil = async (p: Principal, uid: string, done: (ical: string) => boolean): Promise<string | null> => {
  let last: string | null = null
  for (let i = 0; i < 20; i += 1) {
    const found = await fetchEvent(p.cfg, { calendarUrl: p.defaultUrl, token: TOKEN, uid })
    last = found?.data ?? null
    if (last !== null && done(last)) {
      return last
    }
    await sleep(1000)
  }
  return last
}

// The master's PARTSTAT for `addr` in a stored object.
const partstatOf = (ical: string, addr: string): string | undefined =>
  parseEvents(ical)
    .find((e) => e.recurrenceId === undefined)
    ?.attendees.find((a) => a.email.toLowerCase() === addr.toLowerCase())?.status

// The attendee accepts the series by flipping their own PARTSTAT in their copy;
// Stalwart sends the REPLY to the organizer's account.
const acceptSeries = async (p: Principal, uid: string): Promise<void> => {
  const found = await fetchEvent(p.cfg, { calendarUrl: p.defaultUrl, token: TOKEN, uid })
  if (!found) {
    throw new Error(`${p.addr} never received ${uid}`)
  }
  const unfolded = found.data.replace(FOLD_RE, '')
  const accepted = unfolded
    .split(NEWLINE_RE)
    .map((l) =>
      l.startsWith('ATTENDEE') && l.toLowerCase().endsWith(`:mailto:${p.addr}`)
        ? l.replace(PARTSTAT_RE, 'PARTSTAT=ACCEPTED')
        : l
    )
    .join('\r\n')
  const res = await fetch(found.url, {
    body: accepted,
    headers: {
      authorization: p.basic,
      'content-type': 'text/calendar; charset=utf-8',
      ...(found.etag ? { 'if-match': found.etag } : {}),
    },
    method: 'PUT',
  })
  if (res.status >= 300) {
    throw new Error(`attendee PUT returned HTTP ${res.status}`)
  }
}

live('update_calendar_event keeps attendee replies against live Stalwart (#837)', () => {
  const run = Date.now()
  const ids: string[] = []
  let org: Principal
  let guest: Principal

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }
    org = await provision(`mcp-kp-org-${run}`, domainId, ids)
    guest = await provision(`mcp-kp-guest-${run}`, domainId, ids)
  }, 60_000)

  afterAll(async () => {
    if (ids.length) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('a description-only edit keeps ACCEPTED and SEQUENCE; a start change resets the reply', async () => {
    const uid = `keeps-partstat-${run}@mcp-e2e`
    const start = nextTuesday()
    await putEvent(org.cfg, {
      calendarUrl: org.defaultUrl,
      ical: buildInvite({
        attendees: [guest.addr],
        end: new Date(start.getTime() + 1_800_000),
        organizer: org.organizer,
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        start,
        title: 'Weekly sync',
        uid,
      }),
      token: TOKEN,
    })

    // Wait for the invite, accept it, and wait for the REPLY to land.
    expect(await copyUntil(guest, uid, () => true)).not.toBeNull()
    await acceptSeries(guest, uid)
    const replied = await copyUntil(org, uid, (ical) => partstatOf(ical, guest.addr) === 'ACCEPTED')
    expect(partstatOf(replied ?? '', guest.addr)).toBe('ACCEPTED')
    const sequenceBefore = parseSequence(replied ?? '')

    const edited = await updateCalendarEvent(makeLiveDeps(org.cfg), {
      args: { description: 'Agenda: roadmap', uid },
      token: TOKEN,
    })
    expect(edited.isError).toBeUndefined()

    const orgCopy = await copyUntil(org, uid, (ical) => ical.includes('Agenda: roadmap'))
    expect(partstatOf(orgCopy ?? '', guest.addr)).toBe('ACCEPTED')
    expect(parseSequence(orgCopy ?? '')).toBe(sequenceBefore)

    // The REQUEST still reaches the attendee and carries their own reply.
    const guestCopy = await copyUntil(guest, uid, (ical) => ical.includes('Agenda: roadmap'))
    expect(guestCopy).toContain('Agenda: roadmap')
    expect(partstatOf(guestCopy ?? '', guest.addr)).toBe('ACCEPTED')

    // A reschedule is the one edit that asks everyone to answer again.
    const moved = await updateCalendarEvent(makeLiveDeps(org.cfg), {
      args: { start: new Date(start.getTime() + 3_600_000).toISOString(), uid },
      token: TOKEN,
    })
    expect(moved.isError).toBeUndefined()
    const movedCopy = await copyUntil(org, uid, (ical) => parseSequence(ical) > sequenceBefore)
    expect(partstatOf(movedCopy ?? '', guest.addr)).toBe('NEEDS-ACTION')
  }, 120_000)
})
