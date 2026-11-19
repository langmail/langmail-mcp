// E2E for unsubscribe_from_list against a REAL Stalwart.
// The unit tests prove the parser and the guards against fake records; this
// proves the JMAP read does what the parser assumes on the wire: Stalwart
// hands back `header:List-Unsubscribe` in Raw form with the folding intact,
// the Post header as text, every Delivered-To, and the Junk role. The one-click
// POST is captured by a stub hop, so the test never reaches the network.
//
// Skips unless STALWART_ADMIN_URL is set. Run locally against the shared dev
// compose (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test unsubscribe-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { emailGetUnsubscribe, mailboxCreate, mailboxIdsByRoles, makeJmapLive } from '../jmap/index.ts'
import { type SendHop } from './one-click-post.ts'
import { type UnsubscribeDeps, unsubscribeFromList } from './unsubscribe-from-list.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

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

live('unsubscribe_from_list against live Stalwart', () => {
  const run = Date.now()
  const localPart = `mcp-unsub-e2e-${run}`

  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let uploadUrl: string
  let inboxId: string
  let junkId: string
  let hops: [string, string][]
  let deps: UnsubscribeDeps

  const importEmail = async (headers: string[], mailboxId: string, keywords: Record<string, boolean> = {}) => {
    const raw = [
      `Delivered-To: ${address}`,
      'Delivered-To: jo.forwarded@old.example',
      'From: News <news@news.example.com>',
      `To: ${address}`,
      `Subject: Weekly news ${run}`,
      `Message-ID: <unsub-${run}-${Math.random().toString(36).slice(2)}@mcp-unsub-e2e>`,
      `Date: ${new Date(run).toUTCString()}`,
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This week in news.',
      'Unsubscribe: https://news.example.com/footer-unsubscribe?id=7',
    ].join('\r\n')

    const uploadRes = await fetch(uploadUrl.replace('{accountId}', accountId).replace('{type}', 'message/rfc822'), {
      body: raw,
      headers: { authorization, 'content-type': 'message/rfc822' },
      method: 'POST',
    })
    expect(uploadRes.status).toBe(200)
    const { blobId } = (await uploadRes.json()) as { blobId: string }

    const importRes = await fetch(apiUrl, {
      body: JSON.stringify({
        methodCalls: [
          [
            'Email/import',
            {
              accountId,
              emails: {
                i0: { blobId, keywords, mailboxIds: { [mailboxId]: true }, receivedAt: new Date(run).toISOString() },
              },
            },
            '0',
          ],
        ],
        using: USING,
      }),
      headers: { authorization, 'content-type': 'application/json' },
      method: 'POST',
    })
    const json = (await importRes.json()) as {
      methodResponses: [string, { created?: Record<string, { id: string }> }, string][]
    }
    const created = json.methodResponses[0]?.[1]?.created?.i0
    if (!created) {
      throw new Error(`Email/import failed: ${JSON.stringify(json)}`)
    }
    return created.id
  }

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
    const minted = await adminCall('x:AppPassword/set', {
      accountId: account.id,
      create: { ap1: { allowedIps: {}, description: 'mcp unsubscribe e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`

    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string; uploadUrl: string }
    apiUrl = session.apiUrl
    uploadUrl = session.uploadUrl
    accountId = await makeJmapLive(ADMIN_URL as string).resolveAccountId(authorization)

    const call = { accountId, apiUrl, authorization }
    const roles = await mailboxIdsByRoles({ ...call, roles: ['inbox', 'junk'] })
    if (!roles.inbox) {
      throw new Error('no inbox mailbox on the throwaway account')
    }
    inboxId = roles.inbox
    junkId = roles.junk ?? (await mailboxCreate({ ...call, name: 'Junk', role: 'junk' }))

    hops = []
    const sendHop: SendHop = (url, method) => {
      hops.push([url, method])
      return Promise.resolve({ body: 'Unsubscribe Request Accepted', location: null, status: 202 })
    }
    // Live JMAP reads with the Basic credential pinned; only the hop is stubbed.
    deps = {
      fetchMessage: (p) => emailGetUnsubscribe({ ...p, ...call }),
      junkMailboxId: () => Promise.resolve(junkId),
      resolveAccountId: () => Promise.resolve(accountId),
      sendHop,
    }
  })

  afterAll(async () => {
    const query = await adminCall('x:Account/query', { filter: { name: localPart } })
    const ids = (query.ids as string[] | undefined) ?? []
    if (ids.length > 0) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  const FOLDED = [
    'List-Unsubscribe: <https://news.example.com/unsubscribe?u=1&id=2>,',
    ' <mailto:leave@news.example.com?subject=unsubscribe>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ]

  test('reads a folded List-Unsubscribe in Raw form and every Delivered-To, newest first', async () => {
    const id = await importEmail(FOLDED, inboxId)
    const rec = await emailGetUnsubscribe({ accountId, apiUrl, authorization, id, maxBodyValueBytes: 10_000 })
    expect(rec?.['header:List-Unsubscribe']).toContain('\r\n <mailto:')
    expect(rec?.['header:List-Unsubscribe-Post:asText']).toBe('List-Unsubscribe=One-Click')
    expect(rec?.['header:Delivered-To:asText:all']?.[0]).toBe(address)
  })

  test('one-click: the tool POSTs the parsed https link and reports the request as accepted', async () => {
    hops.length = 0
    const id = await importEmail(FOLDED, inboxId)
    const result = await unsubscribeFromList(deps, { args: { id }, token: TOKEN })
    expect(hops).toEqual([['https://news.example.com/unsubscribe?u=1&id=2', 'POST']])
    expect(result.content[0]?.text).toContain('Unsubscribe request accepted by news.example.com (HTTP 202).')
    expect(result.content[0]?.text).toContain(`delivered to ${address}`)
  })

  test('mail in Junk is refused without a request', async () => {
    hops.length = 0
    const id = await importEmail(FOLDED, junkId)
    const result = await unsubscribeFromList(deps, { args: { id }, token: TOKEN })
    expect(result.isError).toBe(true)
    expect(hops).toEqual([])
  })

  test('no header: the footer link from the real text body', async () => {
    const id = await importEmail([], inboxId)
    const result = await unsubscribeFromList(deps, { args: { id }, token: TOKEN })
    expect(result.content[0]?.text).toContain('no automatic way to unsubscribe')
    expect(result.content[0]?.text).toContain('https://news.example.com/footer-unsubscribe?id=7')
  })
})
