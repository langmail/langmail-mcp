// E2E for single-occurrence cancellation (delete_calendar_event + recurrenceId)
// against a REAL Stalwart, verifying the full fan-out — the part Radicale can't
// reproduce (it does no scheduling).
//
// It provisions two throwaway accounts on the dev Stalwart (raw admin JMAP — the
// same x:-method contract services/auth uses): an organizer and a LOCAL
// attendee. The organizer seeds a weekly series inviting the attendee, then the
// real delete tool (live deps, CalDAV all the way) cancels one occurrence. We
// assert both sides:
//   1. the stored object survives the PUT with the instant excluded (EXDATE on
//      the master, no override, RRULE intact) — i.e. Stalwart's scheduler ACCEPTS
//      the EXDATE + bumped-SEQUENCE object rather than rejecting it;
//   2. the attendee actually receives the scheduling message. NB (this is the
//      verification spike for the design's SEQUENCE question): Stalwart 0.16
//      delivers a single-occurrence cancellation as an *updated-series
//      METHOD:REQUEST carrying the new EXDATE*, NOT a per-instance METHOD:CANCEL.
//      The attendee client applies the updated series and drops just that
//      occurrence; the RRULE (and every other occurrence) survives. The bumped
//      master SEQUENCE is what makes the client treat the update as newer
//      (RFC 5546) — hence we keep it.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-cancel-occurrence

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { parseEvents } from '@langmail/ical'

import { deleteCalendarEvent, makeLiveDeps } from '../tools/delete-calendar-event.ts'
import { type CalDavConfig, discoverAccount, fetchEvent, putEvent } from './client.ts'
import { buildInvite } from './ical.ts'
import { toIcalUtc } from './recurrence.ts'

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

// Provisions a throwaway account and returns a Basic credential for it.
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
    create: { ap1: { allowedIps: {}, description: 'mcp cancel e2e', permissions: { '@type': 'Inherit' } } },
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

// Undo quoted-printable so the calendar body reads as plain iCalendar: rejoin
// soft line breaks (`=\r\n`) and decode `=XX` hex escapes (Stalwart QP-encodes
// the text/calendar part, so `FREQ=WEEKLY` ships as `FREQ=3DWEEKLY`).
const HEX_RE = /=([0-9A-Fa-f]{2})/gu
const qpDecode = (raw: string): string =>
  raw.replace(/=\r?\n/gu, '').replace(HEX_RE, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

// The attendee's JMAP mail account id (from their session).
const mailAccountId = async (basic: string): Promise<string> => {
  const sess = (await (await fetch(`${ADMIN_URL}/jmap/session`, { headers: { authorization: basic } })).json()) as {
    primaryAccounts?: Record<string, string>
  }
  const id = sess.primaryAccounts?.['urn:ietf:params:jmap:mail']
  if (!id) {
    throw new Error('no JMAP mail account for attendee')
  }
  return id
}

// Every message in the attendee's mailbox, decoded to plain text (headers +
// iCalendar body). Matches by content, not mailbox, so it needs no folder id.
const attendeeMessages = async (basic: string, accountId: string): Promise<string[]> => {
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

// Polls the attendee mailbox until a scheduling message carrying `marker`
// (the EXDATE line) arrives, or times out.
const waitForCalendarWith = async (basic: string, accountId: string, marker: string): Promise<string | null> => {
  for (let i = 0; i < 20; i += 1) {
    for (const body of await attendeeMessages(basic, accountId)) {
      if (body.includes('BEGIN:VCALENDAR') && body.includes(marker)) {
        return body
      }
    }
    await sleep(2000)
  }
  return null
}

live('delete_calendar_event single occurrence against live Stalwart', () => {
  const run = Date.now()
  const orgPart = `mcp-cancel-org-${run}`
  const attPart = `mcp-cancel-att-${run}`
  let orgId: string
  let attId: string
  let attBasic: string
  let attMailAccount: string
  let attendeeAddr: string
  let cfg: CalDavConfig
  let calendarUrl: string
  let organizer: string

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }

    const org = await provisionAccount(orgPart, domainId)
    const att = await provisionAccount(attPart, domainId)
    orgId = org.id
    attId = att.id
    attBasic = att.basic
    attendeeAddr = `${attPart}@${DOMAIN}`
    attMailAccount = await mailAccountId(attBasic)

    cfg = { authHeaders: () => ({ authorization: org.basic }), serverUrl: ADMIN_URL as string }
    const discovery = await discoverAccount(cfg, TOKEN)
    if (!(discovery.defaultCalendarUrl && discovery.organizer)) {
      throw new Error(`discovery incomplete: ${JSON.stringify(discovery)}`)
    }
    calendarUrl = discovery.defaultCalendarUrl
    organizer = discovery.organizer
  })

  afterAll(async () => {
    // Throwaway principals; destroying them also drops their calendar/mail data.
    const ids = [orgId, attId].filter(Boolean)
    if (ids.length) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('cancels one occurrence: Stalwart accepts the EXDATE PUT and the attendee gets the exclusion', async () => {
    const uid = `cancel-occurrence-${run}@mcp-e2e`
    const start = nextTuesday()
    await putEvent(cfg, {
      calendarUrl,
      ical: buildInvite({
        attendees: [attendeeAddr],
        end: hoursLater(start, 0.5),
        organizer,
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        start,
        title: 'Weekly sync',
        uid,
      }),
      token: TOKEN,
    })
    // Wait for the initial series invitation to reach the attendee, so the cancel
    // fan-out is a genuine second delivery, not a race with the first.
    const invite = await waitForCalendarWith(attBasic, attMailAccount, 'RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(invite).not.toBeNull()

    // Cancel occurrence #2 (one week out — still a Tuesday, so on the rule).
    const occurrence = new Date(start.getTime() + 7 * 86_400_000)
    const exdate = toIcalUtc(occurrence.toISOString())
    const result = await deleteCalendarEvent(makeLiveDeps(cfg), {
      args: { calendarUrl, recurrenceId: occurrence.toISOString(), uid },
      token: TOKEN,
    })

    // On rejection this would surface `caldav PUT returned <4xx>`; the scheduler
    // accepting the EXDATE + master SEQUENCE bump is half the point.
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('cancelled')

    // Stored object: the instant is excluded on the master, the master still
    // recurs, and no override dangles.
    const stored = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(stored).not.toBeNull()
    expect(stored?.data).toContain(`EXDATE:${exdate}`)
    expect(stored?.data).not.toContain('RECURRENCE-ID')
    const events = parseEvents(stored?.data ?? '')
    expect(events).toHaveLength(1)
    expect(events[0]?.recurrence).toBeDefined()

    // Fan-out: the attendee receives the exclusion as an updated-series REQUEST
    // carrying the new EXDATE — the series (RRULE) survives, so it is NOT a
    // whole-series cancellation.
    const delivered = await waitForCalendarWith(attBasic, attMailAccount, `EXDATE:${exdate}`)
    expect(delivered).not.toBeNull()
    expect(delivered).toContain('METHOD:REQUEST')
    expect(delivered).not.toContain('METHOD:CANCEL')
    expect(delivered).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
  }, 60_000)
})
