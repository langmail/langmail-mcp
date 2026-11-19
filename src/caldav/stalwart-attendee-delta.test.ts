// E2E for attendee-delta edits (update_calendar_event + addedAttendees/
// removedAttendees + notify) against a REAL Stalwart — the fan-out behaviour
// Radicale can't reproduce (it does no scheduling). This is the acceptance
// proof for the reported gap: a single attendee is removed from a recurring
// meeting through the connector alone, re-passing neither the recurrence rule
// nor the other attendees, and — with notify:'none' — without disturbing the
// attendees who remain.
//
// It provisions three throwaway accounts on the dev Stalwart (raw admin JMAP —
// the same x:-method contract services/auth uses): an organizer and two LOCAL
// attendees (one that gets removed, one that stays). The organizer seeds a
// weekly series inviting both, then the real update tool (live deps, CalDAV all
// the way) removes one attendee by email. We assert:
//   1. quiet path (notify:'none') — the stored series drops the removed attendee,
//      keeps the other AND its RRULE, and the remaining attendee is NOT
//      re-notified (a subsequent loud edit proves the mailbox pipe is live, so
//      the zero-delivery is real suppression, not a dead channel);
//   2. loud path (notify default 'all') — removing an attendee DOES re-notify the
//      remaining attendee, and the delivered series no longer lists the removed one.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-attendee-delta

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { parseEvents } from '../ical/index.ts'
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

const provisionAccount = async (localPart: string, domainId: string): Promise<{ basic: string; id: string }> => {
  const created = await adminCall('x:Account/set', {
    create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
  })
  const id = (created.created as { a1?: { id?: string } } | undefined)?.a1?.id
  if (!id) {
    throw new Error(`account not created: ${JSON.stringify(created)}`)
  }
  const minted = await adminCall('x:AppPassword/set', {
    accountId: id,
    create: { ap1: { allowedIps: {}, description: 'mcp attendee-delta e2e', permissions: { '@type': 'Inherit' } } },
  })
  const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
  if (!secret) {
    throw new Error(`app password not created: ${JSON.stringify(minted)}`)
  }
  return { basic: `Basic ${Buffer.from(`${localPart}@${DOMAIN}:${secret}`).toString('base64')}`, id }
}

// 10:00Z on a Tuesday comfortably in the future, so Stalwart treats the series
// as schedulable and the run date never catches up with it.
const nextTuesday = (): Date => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(10, 0, 0, 0)
  return d
}
const hoursLater = (from: Date, hours: number): Date => new Date(from.getTime() + hours * 3_600_000)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Undo quoted-printable so the calendar body reads as plain iCalendar (Stalwart
// QP-encodes the text/calendar part) — same helper the cancel-occurrence e2e uses.
const HEX_RE = /=([0-9A-Fa-f]{2})/gu
const qpDecode = (raw: string): string =>
  raw.replace(/=\r?\n/gu, '').replace(HEX_RE, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

// Undo RFC 5545 line folding (CRLF + a leading space/tab) so a substring check
// isn't fooled by a folded ATTENDEE address — ical-generator folds at 75 octets,
// which splits our ~38-char generated addresses mid-value.
const unfold = (ical: string): string => ical.replace(/\r\n[ \t]/gu, '')

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

// Every message in a mailbox, decoded to plain text (headers + iCalendar body).
const messages = async (basic: string, accountId: string): Promise<string[]> => {
  const res = (await (
    await fetch(`${ADMIN_URL}/jmap/`, {
      body: JSON.stringify({
        methodCalls: [
          ['Email/query', { accountId }, '0'],
          [
            'Email/get',
            { '#ids': { name: 'Email/query', path: '/ids', resultOf: '0' }, accountId, properties: ['blobId'] },
            '1',
          ],
        ],
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      }),
      headers: { authorization: basic, 'content-type': 'application/json' },
      method: 'POST',
    })
  ).json()) as { methodResponses?: [string, { list?: { blobId: string }[] }, string][] }
  const list = res.methodResponses?.[1]?.[1]?.list ?? []
  const bodies: string[] = []
  for (const m of list) {
    const raw = await (
      await fetch(`${ADMIN_URL}/jmap/download/${accountId}/${m.blobId}/m.eml?accept=message/rfc822`, {
        headers: { authorization: basic },
      })
    ).text()
    bodies.push(qpDecode(raw))
  }
  return bodies
}

const messageCount = async (basic: string, accountId: string): Promise<number> =>
  (await messages(basic, accountId)).length

// Polls a mailbox until it holds more than `previous` messages (a new delivery),
// returning the decoded bodies once it does, or null on timeout.
const waitForNewMessage = async (basic: string, accountId: string, previous: number): Promise<string[] | null> => {
  for (let i = 0; i < 20; i += 1) {
    const bodies = await messages(basic, accountId)
    if (bodies.length > previous) {
      return bodies
    }
    await sleep(2000)
  }
  return null
}

// Confirms a mailbox stays at `expected` messages across a settle window — i.e.
// no scheduling message arrives. Bounded (~12s); the loud-edit follow-up proves
// the pipe is live so this zero-delivery is genuine suppression.
const staysAt = async (basic: string, accountId: string, expected: number): Promise<boolean> => {
  for (let i = 0; i < 6; i += 1) {
    if ((await messageCount(basic, accountId)) > expected) {
      return false
    }
    await sleep(2000)
  }
  return true
}

live('update_calendar_event attendee deltas against live Stalwart', () => {
  const run = Date.now()
  const orgPart = `mcp-ad-org-${run}`
  const goneParts = [`mcp-ad-gone1-${run}`, `mcp-ad-gone2-${run}`]
  const stayParts = [`mcp-ad-stay1-${run}`, `mcp-ad-stay2-${run}`]
  const ids: string[] = []
  let cfg: CalDavConfig
  let calendarUrl: string
  let organizer: string
  // [removed, remaining] pairs — one pair per test so mailbox counts don't cross.
  const removed: { addr: string; basic: string; mail: string }[] = []
  const remaining: { addr: string; basic: string; mail: string }[] = []

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }

    const org = await provisionAccount(orgPart, domainId)
    ids.push(org.id)
    cfg = { authHeaders: () => ({ authorization: org.basic }), serverUrl: ADMIN_URL as string }
    const discovery = await discoverAccount(cfg, TOKEN)
    if (!(discovery.defaultCalendarUrl && discovery.organizer)) {
      throw new Error(`discovery incomplete: ${JSON.stringify(discovery)}`)
    }
    calendarUrl = discovery.defaultCalendarUrl
    organizer = discovery.organizer

    for (let i = 0; i < 2; i += 1) {
      const gone = await provisionAccount(goneParts[i] as string, domainId)
      const stay = await provisionAccount(stayParts[i] as string, domainId)
      ids.push(gone.id, stay.id)
      removed.push({ addr: `${goneParts[i]}@${DOMAIN}`, basic: gone.basic, mail: await mailAccountId(gone.basic) })
      remaining.push({ addr: `${stayParts[i]}@${DOMAIN}`, basic: stay.basic, mail: await mailAccountId(stay.basic) })
    }
    // ~15 sequential JMAP round-trips against a possibly cold Stalwart; give the
    // hook generous headroom over bun's default so setup never times out mid-provision.
  }, 60_000)

  afterAll(async () => {
    if (ids.length) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  // Seeds a weekly series inviting [removed, remaining] and waits until the
  // remaining attendee has received the initial invitation.
  const seedSeries = async (uid: string, gone: (typeof removed)[number], stay: (typeof remaining)[number]) => {
    const start = nextTuesday()
    await putEvent(cfg, {
      calendarUrl,
      ical: buildInvite({
        attendees: [gone.addr, stay.addr],
        end: hoursLater(start, 0.5),
        organizer,
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        start,
        title: 'unvibe meeting',
        uid,
      }),
      token: TOKEN,
    })
    const invited = await waitForNewMessage(stay.basic, stay.mail, 0)
    expect(invited).not.toBeNull()
  }

  test('notify:none removes one attendee without re-passing the rule or the others, and stays quiet', async () => {
    const gone = removed[0] as (typeof removed)[number]
    const stay = remaining[0] as (typeof remaining)[number]
    const uid = `attendee-delta-quiet-${run}@mcp-e2e`
    await seedSeries(uid, gone, stay)
    const stayBaseline = await messageCount(stay.basic, stay.mail)

    // The whole acceptance surface in one call: name only the address to drop,
    // and ask for silence. No recurrence, no other attendees, no times.
    const result = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: { notify: 'none', removedAttendees: [gone.addr], uid },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    // Stored series: the removed attendee is gone, the remaining one survives,
    // the RRULE is intact, and it's still a single (master) VEVENT.
    const stored = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(stored).not.toBeNull()
    const events = parseEvents(stored?.data ?? '')
    expect(events).toHaveLength(1)
    const emails = (events[0]?.attendees ?? []).map((a) => a.email.toLowerCase())
    expect(emails).toContain(stay.addr.toLowerCase())
    expect(emails).not.toContain(gone.addr.toLowerCase())
    expect(events[0]?.recurrence).toBe('FREQ=WEEKLY;BYDAY=TU')

    // The remaining attendee is NOT re-notified by the quiet edit.
    expect(await staysAt(stay.basic, stay.mail, stayBaseline)).toBe(true)

    // Prove the mailbox pipe is live: a subsequent loud edit (default notify)
    // DOES reach them, so the silence above was real suppression, not a dead
    // channel. Re-adding the dropped attendee is a real, notifying change.
    const loud = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: { addedAttendees: [gone.addr], uid },
      token: TOKEN,
    })
    expect(loud.isError).toBeUndefined()
    expect(await waitForNewMessage(stay.basic, stay.mail, stayBaseline)).not.toBeNull()
  }, 120_000)

  test('default notify re-notifies the remaining attendee and drops the removed one from their copy', async () => {
    const gone = removed[1] as (typeof removed)[number]
    const stay = remaining[1] as (typeof remaining)[number]
    const uid = `attendee-delta-loud-${run}@mcp-e2e`
    await seedSeries(uid, gone, stay)
    const stayBaseline = await messageCount(stay.basic, stay.mail)

    // Same delta, but notify defaults to 'all'.
    const result = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: { removedAttendees: [gone.addr], uid },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    const delivered = await waitForNewMessage(stay.basic, stay.mail, stayBaseline)
    expect(delivered).not.toBeNull()
    // At least one delivered scheduling message for this event is the updated
    // series (RRULE intact) that no longer lists the removed attendee — the
    // initial invite still lists them, so match on the update specifically.
    // Unfold first: the folded ATTENDEE address would otherwise never substring-
    // match, making `!includes(gone.addr)` vacuously true (a false green).
    const updates = (delivered ?? []).map(unfold).filter((b) => b.includes('BEGIN:VCALENDAR') && b.includes(uid))
    expect(updates.some((b) => b.includes('RRULE:FREQ=WEEKLY;BYDAY=TU') && !b.includes(gone.addr))).toBe(true)
  }, 120_000)
})
