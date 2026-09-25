// Spike for move_calendar_events (docs/proposals/2026-09-25-move-calendar-events)
// against a REAL Stalwart. Reading crates/dav/src/calendar/copy_move.rs says a
// same-account CalDAV MOVE only re-parents the stored event — no copy, no iTIP.
// This checks that reading on the wire before the tool is built:
//   1. fidelity and silence — a recurring organizer event with an override, a
//      VALARM, TRANSP and an X- property moves byte-identically, and the local
//      attendee receives nothing; a later edit in the new calendar still
//      notifies (so the silence is real, and scheduling survives the move);
//   2. invitations after a move — an invitee files the organizer's event on a
//      non-default calendar, the organizer then updates it: where does the
//      update land?
//   3. wire details — Destination as an absolute URL vs a path, Overwrite: F on
//      an occupied name, a UID already present in the target, and tsdav's
//      davRequest carrying a MOVE through;
//   4. resource names a foreign client may write (`@`, non-ASCII) move under
//      the spelling the listing reports
//      (docs/upstream/stalwart/caldav-resource-name-encoding-asymmetric.md);
//   5. an attendee's REPLY still reaches an organized event after it moved.
//      Only the local path is exercised: Stalwart processes a mailed iMIP only
//      from an authenticated, non-spam sender (crates/email/src/message/
//      ingest.rs), which the dev MTA cannot give an outside address. Both paths
//      end in the same `itip_ingest`, which looks the UID up account-wide.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-move-event

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { davRequest } from 'tsdav'

import { parseEvents } from '@langmail/ical'

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

const provision = async (localPart: string, domainId: string): Promise<Principal> => {
  const created = await adminCall('x:Account/set', {
    create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
  })
  const id = (created.created as { a1?: { id?: string } } | undefined)?.a1?.id
  if (!id) {
    throw new Error(`account not created: ${JSON.stringify(created)}`)
  }
  const minted = await adminCall('x:AppPassword/set', {
    accountId: id,
    create: { ap1: { allowedIps: {}, description: 'mcp move spike', permissions: { '@type': 'Inherit' } } },
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

const staysAt = async (p: Principal, expected: number): Promise<boolean> => {
  for (let i = 0; i < 6; i += 1) {
    if ((await messageCount(p)) > expected) {
      return false
    }
    await sleep(2000)
  }
  return true
}

// Raw GET of one stored object: status, exact body, ETag.
const get = async (p: Principal, url: string) => {
  const res = await fetch(url, { headers: { authorization: p.basic } })
  return { body: await res.text(), etag: res.headers.get('etag'), status: res.status }
}

const move = async (p: Principal, url: string, destination: string, overwrite: 'F' | 'T' = 'F') => {
  const res = await fetch(url, {
    headers: { authorization: p.basic, destination, overwrite },
    method: 'MOVE',
  })
  return { body: await res.text(), status: res.status }
}

const resourceName = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

// A future Tuesday 10:00Z, as a basic-format iCalendar UTC stamp.
const futureStart = (weeks: number): Date => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + weeks * 7 + ((9 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(10, 0, 0, 0)
  return d
}
const STAMP_SEPARATORS_RE = /[-:]/gu
const MILLIS_RE = /\.\d{3}/u
const SEQUENCE_RE = /SEQUENCE:(\d+)/u
const stamp = (d: Date): string => d.toISOString().replace(STAMP_SEPARATORS_RE, '').replace(MILLIS_RE, '')
const plusMinutes = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000)

const ics = (lines: string[]): string => `${lines.join('\r\n')}\r\n`

// A weekly series organized by `org` with one moved occurrence, an alarm,
// TRANSP, a description and a custom property — everything a copy-and-delete
// would lose.
const richSeries = (uid: string, org: Principal, attendee: Principal | null): string => {
  const start = futureStart(4)
  const second = new Date(start.getTime() + 7 * 86_400_000)
  const people = attendee
    ? [`ORGANIZER:mailto:${org.addr}`, `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee.addr}`]
    : []
  return ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//langmail//move-spike//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(plusMinutes(start, 60))}`,
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'SUMMARY:Back yoga',
    'DESCRIPTION:Bring the mat',
    'TRANSP:TRANSPARENT',
    'X-LANGMAIL-SPIKE:keep-me',
    ...people,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'TRIGGER:-PT30M',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `RECURRENCE-ID:${stamp(second)}`,
    `DTSTART:${stamp(plusMinutes(second, 120))}`,
    `DTEND:${stamp(plusMinutes(second, 180))}`,
    'SUMMARY:Back yoga (moved)',
    ...people,
    'END:VEVENT',
    'END:VCALENDAR',
  ])
}

const plainEvent = (uid: string, title: string): string => {
  const start = futureStart(6)
  return ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//langmail//move-spike//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(plusMinutes(start, 30))}`,
    `SUMMARY:${title}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ])
}

const objectUrl = async (p: Principal, calendarUrl: string, uid: string): Promise<string> => {
  const found = await fetchEvent(p.cfg, { calendarUrl, token: TOKEN, uid })
  if (!found) {
    throw new Error(`uid ${uid} not in ${calendarUrl}`)
  }
  return found.url
}

const uidsIn = async (p: Principal, calendarUrl: string): Promise<{ summary: string; uid: string }[]> =>
  (await fetchEvents(p.cfg, { calendarUrl, token: TOKEN })).flatMap((o) =>
    parseEvents(o.data).map((e) => ({ summary: e.title, uid: e.uid }))
  )

live('CalDAV MOVE between calendars against live Stalwart (spike)', () => {
  const run = Date.now()
  const ids: string[] = []
  let org: Principal
  let att: Principal
  let orgPrivate: string
  let attPrivate: string

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }
    org = await provision(`mcp-mv-org-${run}`, domainId)
    att = await provision(`mcp-mv-att-${run}`, domainId)
    ids.push(org.id, att.id)
    orgPrivate = await createCalendar(org.cfg, { name: 'Private', token: TOKEN })
    attPrivate = await createCalendar(att.cfg, { name: 'Private', token: TOKEN })
  }, 60_000)

  afterAll(async () => {
    if (ids.length) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('1. a rich organizer series moves byte-identically and nobody is notified', async () => {
    const uid = `move-rich-${run}@mcp-e2e`
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: richSeries(uid, org, att), token: TOKEN })
    expect(await waitForMoreThan(att, 0)).toBe(true)
    const baseline = await messageCount(att)

    const src = await objectUrl(org, org.defaultUrl, uid)
    const before = await get(org, src)
    const dest = `${orgPrivate}${resourceName(src)}`
    const moved = await move(org, src, dest)
    console.log('[spike 1] MOVE status', moved.status, JSON.stringify(moved.body.slice(0, 200)))
    expect([201, 204]).toContain(moved.status)

    const gone = await get(org, src)
    const after = await get(org, dest)
    console.log('[spike 1] source after', gone.status, '| dest', after.status)
    console.log('[spike 1] etag before', before.etag, 'after', after.etag)
    console.log('[spike 1] byte-identical', before.body === after.body)
    if (before.body !== after.body) {
      console.log('[spike 1] BEFORE\n', before.body, '\n[spike 1] AFTER\n', after.body)
    }
    expect(gone.status).toBe(404)
    expect(after.status).toBe(200)
    expect(after.body).toBe(before.body)

    const quiet = await staysAt(att, baseline)
    console.log('[spike 1] attendee stayed quiet after MOVE', quiet)
    expect(quiet).toBe(true)

    // Control: a real edit in the new calendar still schedules, so the silence
    // above is suppression, not a dead pipe — and the moved event is still a
    // live scheduling object.
    const edited = after.body.replace('SUMMARY:Back yoga\r\n', 'SUMMARY:Back yoga (edited)\r\n')
    const put = await fetch(dest, {
      body: edited,
      headers: {
        authorization: org.basic,
        'content-type': 'text/calendar; charset=utf-8',
        ...(after.etag ? { 'if-match': after.etag } : {}),
      },
      method: 'PUT',
    })
    console.log('[spike 1] control PUT', put.status)
    const notified = await waitForMoreThan(att, baseline)
    console.log('[spike 1] attendee notified by control edit', notified)
    expect(notified).toBe(true)
  }, 120_000)

  test('2. an organizer update reaches an invitation the invitee moved', async () => {
    const uid = `move-invite-${run}@mcp-e2e`
    const before = await messageCount(att)
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainInvite(uid, org, att, 'Offsite'), token: TOKEN })
    expect(await waitForMoreThan(att, before)).toBe(true)

    // Where did Stalwart file the invitation for the attendee?
    let attSrc: string | null = null
    for (let i = 0; i < 10 && !attSrc; i += 1) {
      const found = await fetchEvent(att.cfg, { calendarUrl: att.defaultUrl, token: TOKEN, uid })
      attSrc = found?.url ?? null
      if (!attSrc) {
        await sleep(1000)
      }
    }
    console.log('[spike 2] invitation filed in attendee default calendar', Boolean(attSrc))
    expect(attSrc).not.toBeNull()

    const moved = await move(att, attSrc as string, `${attPrivate}${resourceName(attSrc as string)}`)
    console.log('[spike 2] attendee MOVE status', moved.status)
    expect([201, 204]).toContain(moved.status)

    // Organizer reschedules/renames; Stalwart fans out a REQUEST to the attendee.
    const orgUrl = await objectUrl(org, org.defaultUrl, uid)
    const orgObj = await get(org, orgUrl)
    const baseline = await messageCount(att)
    const updated = orgObj.body
      .replace('SUMMARY:Offsite\r\n', 'SUMMARY:Offsite (new room)\r\n')
      .replace(SEQUENCE_RE, (_m, n: string) => `SEQUENCE:${Number(n) + 1}`)
    const withSeq = updated.includes('SEQUENCE:') ? updated : updated.replace('SUMMARY:', 'SEQUENCE:1\r\nSUMMARY:')
    const put = await fetch(orgUrl, {
      body: withSeq,
      headers: {
        authorization: org.basic,
        'content-type': 'text/calendar; charset=utf-8',
        ...(orgObj.etag ? { 'if-match': orgObj.etag } : {}),
      },
      method: 'PUT',
    })
    console.log('[spike 2] organizer update PUT', put.status)
    expect(await waitForMoreThan(att, baseline)).toBe(true)
    await sleep(3000)

    const inDefault = (await uidsIn(att, att.defaultUrl)).filter((e) => e.uid === uid)
    const inPrivate = (await uidsIn(att, attPrivate)).filter((e) => e.uid === uid)
    console.log('[spike 2] after update: default', JSON.stringify(inDefault), '| private', JSON.stringify(inPrivate))
    // The update follows the event to the calendar the invitee filed it in;
    // Stalwart does not re-create it in the default calendar.
    expect(inDefault).toEqual([])
    expect(inPrivate).toEqual([{ summary: 'Offsite (new room)', uid }])
  }, 120_000)

  test('3a. Destination as a server-absolute path instead of a full URL', async () => {
    const uid = `move-path-${run}@mcp-e2e`
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainEvent(uid, 'Path move'), token: TOKEN })
    const src = await objectUrl(org, org.defaultUrl, uid)
    const destPath = new URL(`${orgPrivate}${resourceName(src)}`).pathname
    const moved = await move(org, src, destPath)
    console.log('[spike 3a] MOVE with path Destination', moved.status, JSON.stringify(moved.body.slice(0, 200)))
  })

  test('3b. Overwrite: F onto an occupied resource name', async () => {
    const uidA = `move-occ-a-${run}@mcp-e2e`
    const uidB = `move-occ-b-${run}@mcp-e2e`
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainEvent(uidA, 'Occupant source'), token: TOKEN })
    await putEvent(org.cfg, { calendarUrl: orgPrivate, ical: plainEvent(uidB, 'Occupant target'), token: TOKEN })
    const src = await objectUrl(org, org.defaultUrl, uidA)
    const occupied = await objectUrl(org, orgPrivate, uidB)
    const moved = await move(org, src, occupied, 'F')
    console.log(
      '[spike 3b] MOVE onto occupied name, Overwrite F',
      moved.status,
      JSON.stringify(moved.body.slice(0, 300))
    )
    const stillThere = await get(org, src)
    const target = await get(org, occupied)
    console.log('[spike 3b] source still', stillThere.status, '| target still B', target.body.includes(uidB))
  })

  test('3c. the target calendar already holds the same UID', async () => {
    const uid = `move-dup-${run}@mcp-e2e`
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainEvent(uid, 'Dup source'), token: TOKEN })
    const dupPut = await putEvent(org.cfg, {
      calendarUrl: orgPrivate,
      ical: plainEvent(uid, 'Dup target'),
      token: TOKEN,
    })
      .then(() => 'ok')
      .catch((err: unknown) => String(err))
    console.log('[spike 3c] PUT same UID into second calendar', dupPut)
    const src = await objectUrl(org, org.defaultUrl, uid)
    const moved = await move(org, src, `${orgPrivate}${resourceName(src)}`)
    console.log('[spike 3c] MOVE with UID already in target', moved.status, JSON.stringify(moved.body.slice(0, 300)))
  })

  test('3d. tsdav davRequest carries a MOVE through', async () => {
    const uid = `move-tsdav-${run}@mcp-e2e`
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainEvent(uid, 'tsdav move'), token: TOKEN })
    const src = await objectUrl(org, org.defaultUrl, uid)
    const res = await davRequest({
      init: {
        body: null,
        headers: { authorization: org.basic, destination: `${orgPrivate}${resourceName(src)}`, overwrite: 'F' },
        method: 'MOVE',
        namespace: 'd',
      },
      url: src,
    })
    console.log('[spike 3d] davRequest MOVE', JSON.stringify(res.map((r) => ({ ok: r.ok, status: r.status }))))
    const landed = await fetchEvent(org.cfg, { calendarUrl: orgPrivate, token: TOKEN, uid })
    console.log('[spike 3d] landed in Private', Boolean(landed))
    expect(landed).not.toBeNull()
  })

  test('3e. MOVE into a calendar that does not exist', async () => {
    const uid = `move-nowhere-${run}@mcp-e2e`
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainEvent(uid, 'Nowhere'), token: TOKEN })
    const src = await objectUrl(org, org.defaultUrl, uid)
    const home = orgPrivate.slice(0, orgPrivate.slice(0, -1).lastIndexOf('/') + 1)
    const moved = await move(org, src, `${home}no-such-calendar/${resourceName(src)}`)
    console.log('[spike 3e] MOVE into missing calendar', moved.status, JSON.stringify(moved.body.slice(0, 200)))
  })

  // docs/upstream/stalwart/caldav-resource-name-encoding-asymmetric.md: the
  // resource segment is emitted verbatim and never decoded, so the spelling of
  // a foreign client's resource name in Destination matters.
  test('4. resource names with @ and non-ASCII move under the spelling the listing reports', async () => {
    const cases = [
      { label: 'at-sign', name: `probe-${run}@example.com.ics` },
      { label: 'non-ascii', name: encodeURIComponent(`termin-ärztin-${run}.ics`) },
    ]
    for (const c of cases) {
      const uid = `move-name-${c.label}-${run}@mcp-e2e`
      const put = await fetch(`${org.defaultUrl}${c.name}`, {
        body: plainEvent(uid, `Name ${c.label}`),
        headers: { authorization: org.basic, 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
        method: 'PUT',
      })
      const listed = await objectUrl(org, org.defaultUrl, uid)
      const listedName = resourceName(listed)
      console.log(`[spike 4 ${c.label}] PUT ${put.status}; name written ${c.name}; listed as ${listedName}`)

      const moved = await move(org, listed, `${orgPrivate}${listedName}`)
      const landed = await objectUrl(org, orgPrivate, uid).catch(() => null)
      const readBack = landed ? await get(org, landed) : null
      console.log(
        `[spike 4 ${c.label}] MOVE ${moved.status}; lands as ${landed ? resourceName(landed) : 'nowhere'}; GET listed href ${readBack?.status}`
      )
      expect([201, 204]).toContain(moved.status)
      expect(readBack?.status).toBe(200)
    }
  })

  test('5a. a local attendee reply reaches an organized event after it moved', async () => {
    const uid = `move-reply-local-${run}@mcp-e2e`
    const before = await messageCount(att)
    await putEvent(org.cfg, { calendarUrl: org.defaultUrl, ical: plainInvite(uid, org, att, 'Planning'), token: TOKEN })
    expect(await waitForMoreThan(att, before)).toBe(true)

    const src = await objectUrl(org, org.defaultUrl, uid)
    const moved = await move(org, src, `${orgPrivate}${resourceName(src)}`)
    expect([201, 204]).toContain(moved.status)

    // The attendee accepts on their own copy; Stalwart turns that into a REPLY.
    let attUrl: string | null = null
    for (let i = 0; i < 10 && !attUrl; i += 1) {
      attUrl = (await fetchEvent(att.cfg, { calendarUrl: att.defaultUrl, token: TOKEN, uid }))?.url ?? null
      if (!attUrl) {
        await sleep(1000)
      }
    }
    const attObj = await get(att, attUrl as string)
    const accepted = unfold(attObj.body).replace(
      `PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${att.addr}`,
      `PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:${att.addr}`
    )
    const rsvp = await fetch(attUrl as string, {
      body: accepted,
      headers: {
        authorization: att.basic,
        'content-type': 'text/calendar; charset=utf-8',
        ...(attObj.etag ? { 'if-match': attObj.etag } : {}),
      },
      method: 'PUT',
    })
    console.log('[spike 5a] attendee RSVP PUT', rsvp.status, 'changed body', accepted !== unfold(attObj.body))

    const status = await waitForPartstat(org, orgPrivate, uid, att.addr, 'ACCEPTED')
    const strayInDefault = (await uidsIn(org, org.defaultUrl)).filter((e) => e.uid === uid)
    console.log(
      '[spike 5a] organizer copy in Private shows',
      status,
      '| stray copies in default',
      strayInDefault.length
    )
    expect(status).toBe('ACCEPTED')
    expect(strayInDefault).toEqual([])
  }, 120_000)
})

const FOLD_RE = /\r\n[ \t]/gu
const unfold = (raw: string): string => raw.replace(FOLD_RE, '')

// Polls the organizer's copy until the attendee's PARTSTAT reads `want`;
// returns whatever it last saw.
const waitForPartstat = async (
  p: Principal,
  calendarUrl: string,
  uid: string,
  attendee: string,
  want: string
): Promise<string | undefined> => {
  let seen: string | undefined
  for (let i = 0; i < 15; i += 1) {
    const found = await fetchEvent(p.cfg, { calendarUrl, token: TOKEN, uid })
    const event = found ? parseEvents(found.data).find((e) => e.uid === uid) : undefined
    seen = event?.attendees.find((a) => a.email.toLowerCase() === attendee.toLowerCase())?.status
    if (seen === want) {
      return seen
    }
    await sleep(2000)
  }
  return seen
}

// A one-off invitation from `org` to `att`.
const plainInvite = (uid: string, org: Principal, att: Principal, title: string): string => {
  const start = futureStart(5)
  return ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//langmail//move-spike//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(plusMinutes(start, 60))}`,
    `SUMMARY:${title}`,
    `ORGANIZER:mailto:${org.addr}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${att.addr}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ])
}
