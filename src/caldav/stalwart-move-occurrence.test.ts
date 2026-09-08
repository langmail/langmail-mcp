// E2E for moving a single occurrence (update_calendar_event + recurrenceId)
// against a REAL Stalwart, asserting the iMIP *method* the attendee receives —
// the part Radicale can't reproduce (it does no scheduling).
//
// This is the regression gate for a defect Stalwart carried from 0.16.13 to
// 0.16.20: `organizer_handle_update` classified a freshly spliced
// RECURRENCE-ID override as an instance "present only in the new object" and
// announced it as iTIP `METHOD:ADD`. RFC 5546 §3.2.4 forbids RECURRENCE-ID in
// METHOD:ADD and §4.4.2 requires METHOD:REQUEST for changing an existing
// instance, so Google Calendar rendered the attendee's copy as "Unable to load
// event" while the organiser saw nothing wrong. Fixed in 0.16.21 (the branch
// now yields `Request`); this test is what keeps a later release from
// regressing it, so its assertions are deliberately about the delivered
// method, not about the PUT being accepted (that is
// stalwart-update-organizer.test.ts).
//
// It provisions two throwaway accounts on the dev Stalwart (raw admin JMAP —
// the same x:-method contract services/auth uses): an organizer and a LOCAL
// attendee, because only a local attendee's mailbox can be read back. The
// organizer seeds a weekly series inviting the attendee, then the real update
// tool (live deps, CalDAV all the way) moves occurrence #2.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-move-occurrence
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
    create: { ap1: { allowedIps: {}, description: 'mcp move e2e', permissions: { '@type': 'Inherit' } } },
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

// Undo RFC 5545 line folding (CRLF + a leading space/tab) so a substring check
// isn't fooled by a folded property value — without this a `METHOD:ADD` split
// across a fold would never match and the negative assertion would pass
// vacuously.
const unfold = (ical: string): string => ical.replace(/\r\n[ \t]/gu, '')

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
// iCalendar body) and unfolded. Matches by content, not mailbox, so it needs no
// folder id.
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
    bodies.push(unfold(qpDecode(raw)))
  }
  return bodies
}

// Polls the attendee mailbox until a scheduling message carrying `marker`
// arrives, or times out.
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

live('update_calendar_event single-occurrence move against live Stalwart', () => {
  const run = Date.now()
  const orgPart = `mcp-move-org-${run}`
  const attPart = `mcp-move-att-${run}`
  let attBasic: string
  let attMailAccount: string
  let attendeeAddr: string
  let cfg: CalDavConfig
  let calendarUrl: string
  const ids: string[] = []
  let organizer: string

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }

    const org = await provisionAccount(orgPart, domainId)
    const att = await provisionAccount(attPart, domainId)
    ids.push(org.id, att.id)
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
  }, 60_000)

  afterAll(async () => {
    // Throwaway principals; destroying them also drops their calendar/mail data.
    if (ids.length) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('moves one occurrence: the attendee gets METHOD:REQUEST with a RECURRENCE-ID, never METHOD:ADD', async () => {
    const uid = `move-occurrence-${run}@mcp-e2e`
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
      uid,
    })
    // Wait for the initial series invitation, so the move fan-out is a genuine
    // second delivery rather than a race with the first.
    expect(await waitForCalendarWith(attBasic, attMailAccount, 'RRULE:FREQ=WEEKLY;BYDAY=TU')).not.toBeNull()

    // Move occurrence #2 (one week out — still a Tuesday, so on the rule) two
    // hours later. The moved title is what distinguishes the override's
    // scheduling message from the initial invite still sitting in the mailbox.
    const occurrence = new Date(start.getTime() + 7 * 86_400_000)
    const movedTitle = 'Weekly sync (moved)'
    const result = await updateCalendarEvent(makeLiveDeps(cfg), {
      args: {
        attendees: [attendeeAddr],
        end: hoursLater(occurrence, 2.5).toISOString(),
        recurrenceId: occurrence.toISOString(),
        start: hoursLater(occurrence, 2).toISOString(),
        title: movedTitle,
        uid,
      },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    // Stored object: master plus the spliced override, both still present.
    const stored = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(stored).not.toBeNull()
    expect(parseEvents(stored?.data ?? '')).toHaveLength(2)

    // The regression gate. Pre-0.16.21 this message was a METHOD:ADD carrying a
    // RECURRENCE-ID — invalid per RFC 5546 §3.2.4 and unrenderable in Google
    // Calendar. It must be a METHOD:REQUEST scoped to the instance.
    const delivered = await waitForCalendarWith(attBasic, attMailAccount, movedTitle)
    expect(delivered).not.toBeNull()
    expect(delivered).toContain('RECURRENCE-ID')
    expect(delivered).toContain('METHOD:REQUEST')
    expect(delivered).not.toContain('METHOD:ADD')
  }, 120_000)
})
