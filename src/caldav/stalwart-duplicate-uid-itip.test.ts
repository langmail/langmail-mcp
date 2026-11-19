// Regression guard for docs/upstream/stalwart/itip-ingest-picks-first-uid-match.md,
// against a REAL Stalwart. CalDAV scopes UID uniqueness to one calendar, so a
// second client can leave the same invitation in two calendars of an account.
// Stalwart's `itip_ingest` then looks the UID up account-wide and applies an
// incoming update to the first match only; the other copy silently keeps the
// old state. This test asserts exactly that — so it turns red, and the upstream
// entry can be retired, when an update reaches both copies or the duplicate is
// refused.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-duplicate-uid-itip

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { parseEvents } from '../ical/index.ts'
import { type CalDavConfig, createCalendar, discoverAccount, fetchEvent, fetchEvents, putEvent } from './client.ts'

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
  id: string
  mail: string
}

const mailAccountId = async (basic: string): Promise<string> => {
  const sess = (await (await fetch(`${ADMIN_URL}/jmap/session`, { headers: { authorization: basic } })).json()) as {
    primaryAccounts?: Record<string, string>
  }
  const id = sess.primaryAccounts?.['urn:ietf:params:jmap:mail']
  if (!id) {
    throw new Error('no JMAP mail account')
  }
  return id
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
    create: { ap1: { allowedIps: {}, description: 'mcp duplicate-uid e2e', permissions: { '@type': 'Inherit' } } },
  })
  const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
  if (!secret) {
    throw new Error(`app password not created: ${JSON.stringify(minted)}`)
  }
  const addr = `${localPart}@${DOMAIN}`
  const basic = `Basic ${Buffer.from(`${addr}:${secret}`).toString('base64')}`
  const cfg: CalDavConfig = { authHeaders: () => ({ authorization: basic }), serverUrl: ADMIN_URL as string }
  const discovery = await discoverAccount(cfg, TOKEN)
  if (!discovery.defaultCalendarUrl) {
    throw new Error(`no default calendar: ${JSON.stringify(discovery)}`)
  }
  return { addr, basic, cfg, defaultUrl: discovery.defaultCalendarUrl, id, mail: await mailAccountId(basic) }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const messageCount = async (p: Principal): Promise<number> => {
  const res = (await (
    await fetch(`${ADMIN_URL}/jmap/`, {
      body: JSON.stringify({
        methodCalls: [['Email/query', { accountId: p.mail }, '0']],
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      }),
      headers: { authorization: p.basic, 'content-type': 'application/json' },
      method: 'POST',
    })
  ).json()) as { methodResponses?: [string, { ids?: string[] }, string][] }
  return res.methodResponses?.[0]?.[1]?.ids?.length ?? 0
}

const waitForMoreThan = async (p: Principal, previous: number): Promise<boolean> => {
  for (let i = 0; i < 20; i += 1) {
    if ((await messageCount(p)) > previous) {
      return true
    }
    await sleep(2000)
  }
  return false
}

const get = async (p: Principal, url: string) => {
  const res = await fetch(url, { headers: { authorization: p.basic } })
  return { body: await res.text(), etag: res.headers.get('etag'), status: res.status }
}

const STAMP_SEPARATORS_RE = /[-:]/gu
const MILLIS_RE = /\.\d{3}/u
const SEQUENCE_RE = /SEQUENCE:(\d+)/u
const stamp = (d: Date): string => d.toISOString().replace(STAMP_SEPARATORS_RE, '').replace(MILLIS_RE, '')

// A future Tuesday 10:00Z, far enough out that Stalwart treats it as schedulable.
const futureStart = (): Date => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 35 + ((9 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(10, 0, 0, 0)
  return d
}

const invite = (uid: string, org: Principal, att: Principal, title: string): string => {
  const start = futureStart()
  const end = new Date(start.getTime() + 3_600_000)
  return `${[
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//langmail//duplicate-uid-e2e//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${title}`,
    `ORGANIZER:mailto:${org.addr}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${att.addr}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')}\r\n`
}

const titlesFor = async (p: Principal, calendarUrl: string, uid: string): Promise<string[]> =>
  (await fetchEvents(p.cfg, { calendarUrl, token: TOKEN }))
    .flatMap((o) => parseEvents(o.data))
    .filter((e) => e.uid === uid)
    .map((e) => e.title)

live('iTIP ingestion with one UID in two calendars (upstream regression guard)', () => {
  const run = Date.now()
  const ids: string[] = []
  let org: Principal
  let att: Principal
  let attSecond: string

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }
    org = await provision(`mcp-dup-org-${run}`, domainId, ids)
    att = await provision(`mcp-dup-att-${run}`, domainId, ids)
    attSecond = await createCalendar(att.cfg, { name: 'Second', token: TOKEN })
  }, 60_000)

  afterAll(async () => {
    if (ids.length) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('an organizer update reaches only one of the two copies', async () => {
    const uid = `dup-uid-update-${run}@mcp-e2e`
    const before = await messageCount(att)
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: invite(uid, org, att, 'Review'), token: TOKEN })
    expect(await waitForMoreThan(att, before)).toBe(true)

    // Stalwart files the invitation in the attendee's default calendar.
    let attUrl: string | null = null
    for (let i = 0; i < 10 && !attUrl; i += 1) {
      attUrl = (await fetchEvent(att.cfg, { calendarUrl: att.defaultUrl, token: TOKEN, uid }))?.url ?? null
      if (!attUrl) {
        await sleep(1000)
      }
    }
    expect(attUrl).not.toBeNull()

    // A second client files a copy of the same invitation in another calendar.
    const copy = await get(att, attUrl as string)
    const dup = await fetch(`${attSecond}${crypto.randomUUID()}.ics`, {
      body: copy.body,
      headers: { authorization: att.basic, 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
      method: 'PUT',
    })
    expect(dup.status).toBe(201)

    // The organizer renames the event; Stalwart delivers the REQUEST.
    const orgUrl = (await fetchEvent(org.cfg, { calendarUrl: org.defaultUrl, token: TOKEN, uid }))?.url
    expect(orgUrl).toBeDefined()
    const orgObj = await get(org, orgUrl as string)
    const renamed = orgObj.body.replace('SUMMARY:Review\r\n', 'SUMMARY:Review (moved to Friday)\r\n')
    expect(renamed).not.toBe(orgObj.body)
    const updated = renamed.includes('SEQUENCE:')
      ? renamed.replace(SEQUENCE_RE, (_m, n: string) => `SEQUENCE:${Number(n) + 1}`)
      : renamed.replace('SUMMARY:', 'SEQUENCE:1\r\nSUMMARY:')
    const baseline = await messageCount(att)
    const put = await fetch(orgUrl as string, {
      body: updated,
      headers: {
        authorization: org.basic,
        'content-type': 'text/calendar; charset=utf-8',
        ...(orgObj.etag ? { 'if-match': orgObj.etag } : {}),
      },
      method: 'PUT',
    })
    expect(put.status).toBe(204)
    expect(await waitForMoreThan(att, baseline)).toBe(true)
    await sleep(3000)

    const titles = [...(await titlesFor(att, att.defaultUrl, uid)), ...(await titlesFor(att, attSecond, uid))].sort()
    // The defect: one copy carries the update, the other keeps the old title.
    expect(titles).toEqual(['Review', 'Review (moved to Friday)'])
  }, 120_000)
})
