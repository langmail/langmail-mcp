// E2E for update_calendar against a REAL Stalwart. The unit tests prove the
// tool picks the right calendar and the client builds a PROPPATCH; this proves
// Stalwart accepts that PROPPATCH and hands the new name and color back on the
// next discovery — the round trip an agent relies on when it renames a
// calendar and then addresses it by the new name.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test stalwart-update-calendar

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { makeLiveDeps, updateCalendar } from '../tools/update-calendar.ts'
import { type CalDavConfig, createCalendar, discoverAccount, fetchCalendarList } from './client.ts'

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

live('update_calendar against live Stalwart — PROPPATCH round trip', () => {
  const localPart = `mcp-e2e-cal-${Date.now()}`
  let accountId: string
  let cfg: CalDavConfig
  let defaultUrl: string

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }

    const created = await adminCall('x:Account/set', {
      create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
    })
    const account = (created.created as { a1?: { id?: string } } | undefined)?.a1
    if (!account?.id) {
      throw new Error(`account not created: ${JSON.stringify(created)}`)
    }
    accountId = account.id

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
    if (!discovery.defaultCalendarUrl) {
      throw new Error(`discovery found no default calendar: ${JSON.stringify(discovery)}`)
    }
    defaultUrl = discovery.defaultCalendarUrl
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its calendar data.
    if (accountId) {
      await adminCall('x:Account/set', { destroy: [accountId] })
    }
  })

  test('renames and recolors the default calendar picked by its current name', async () => {
    const before = (await fetchCalendarList(cfg, TOKEN)).find((c) => c.url === defaultUrl)
    expect(before?.displayName).toBeTruthy()

    const result = await updateCalendar(makeLiveDeps(cfg), {
      args: { calendar: before?.displayName ?? '', color: '#2E6FD8', name: 'Business' },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    const after = (await fetchCalendarList(cfg, TOKEN)).find((c) => c.url === defaultUrl)
    expect(after?.displayName).toBe('Business')
    expect(after?.color?.toUpperCase()).toStartWith('#2E6FD8')
  })

  test('recolors a calendar picked by URL and leaves its name alone', async () => {
    const url = await createCalendar(cfg, { name: 'Side project', token: TOKEN })

    const result = await updateCalendar(makeLiveDeps(cfg), {
      args: { calendar: url, color: '#7FA6C9' },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    const after = (await fetchCalendarList(cfg, TOKEN)).find((c) => c.url === url)
    expect(after?.displayName).toBe('Side project')
    expect(after?.color?.toUpperCase()).toStartWith('#7FA6C9')
  })
})
