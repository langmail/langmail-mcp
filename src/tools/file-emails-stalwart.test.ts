// E2E for archive_emails / move_emails / trash_emails / mark_emails against a
// REAL Stalwart.
// The unit tests prove each tool builds the right patch against fake deps;
// this proves the patch does what we claim on the wire: archive leaves Inbox
// and lands in Archive, move replaces the folder set, trash lands in Trash,
// mark flips $seen without moving the message, and a stale id is reported
// rather than thrown.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password — the deps pin
// the Basic credential while everything downstream is the live path.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test file-emails-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  emailGet,
  emailSetMailboxes,
  emailSetMany,
  mailboxCreate,
  mailboxIdByNameOrRole,
  mailboxIdsByRoles,
  makeJmapLive,
} from '@langmail/jmap'

import { archiveEmails } from './archive-emails.ts'
import { type FileEmailsDeps } from './file-emails-common.ts'
import { lookupMailbox } from './mailbox-lookup.ts'
import { markEmails } from './mark-emails.ts'
import { moveEmails } from './move-emails.ts'
import { trashEmails } from './trash-emails.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']
const NON_WORD_RE = /\W+/gu

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

live('filing tools against live Stalwart', () => {
  const run = Date.now()
  const localPart = `mcp-file-e2e-${run}`

  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let uploadUrl: string
  let inboxId: string
  let archiveId: string
  let projectsId: string
  let trashId: string
  let deps: FileEmailsDeps

  // Import one message straight into the Inbox and return its id.
  const importEmail = async (opts: {
    body: string
    from: string
    keywords: Record<string, boolean>
    receivedAt: Date
    subject: string
  }): Promise<string> => {
    const raw = [
      `From: ${opts.from}`,
      `To: ${address}`,
      `Subject: ${opts.subject}`,
      `Message-ID: <${opts.subject.replaceAll(NON_WORD_RE, '-')}-${run}@mcp-file-e2e>`,
      `Date: ${opts.receivedAt.toUTCString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body,
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
                i0: {
                  blobId,
                  keywords: opts.keywords,
                  mailboxIds: { [inboxId]: true },
                  receivedAt: opts.receivedAt.toISOString(),
                },
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

  const mailboxesOf = async (id: string): Promise<string[]> => {
    const [rec] = await emailGet({ accountId, apiUrl, authorization, ids: [id] })
    return Object.keys(rec?.mailboxIds ?? {}).sort()
  }

  const isSeen = async (id: string): Promise<boolean> => {
    const [rec] = await emailGet({ accountId, apiUrl, authorization, ids: [id] })
    return rec?.keywords?.$seen === true
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
      create: { ap1: { allowedIps: {}, description: 'mcp file e2e', permissions: { '@type': 'Inherit' } } },
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
    const resolvedInbox = await mailboxIdByNameOrRole({ ...call, name: 'Inbox' })
    if (!resolvedInbox) {
      throw new Error('no inbox mailbox on the throwaway account')
    }
    inboxId = resolvedInbox

    // A stock Stalwart account has no Archive; the tool must not create one,
    // so the test does.
    archiveId = await mailboxCreate({ ...call, name: 'Archive', role: 'archive' })
    projectsId = await mailboxCreate({ ...call, name: 'Projects' })
    const roles = await mailboxIdsByRoles({ ...call, roles: ['trash'] })
    if (!roles.trash) {
      throw new Error('no trash mailbox on the throwaway account')
    }
    trashId = roles.trash

    // Live deps with the Basic credential pinned (the tools wrap tokens as
    // Bearer; a dev-Stalwart throwaway account authenticates with Basic).
    deps = {
      replaceMailboxes: (_token, ids, mailboxId) => emailSetMailboxes({ ...call, ids, mailboxId }),
      resolveMailbox: (_token, name) => lookupMailbox(call, name),
      resolvePlaces: async () => {
        const byRole = await mailboxIdsByRoles({ ...call, roles: ['archive', 'inbox', 'trash'] })
        return { archive: byRole.archive ?? null, inbox: byRole.inbox ?? null, trash: byRole.trash ?? null }
      },
      updateEmails: (_token, ids, changes) => emailSetMany({ ...call, changes, ids }),
    }
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its mail. Always query by
    // name (never gate on late-assigned state) so a beforeAll that failed
    // after account creation still cleans up.
    const query = await adminCall('x:Account/query', { filter: { name: localPart } })
    const ids = (query.ids as string[] | undefined) ?? []
    if (ids.length > 0) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('archive_emails leaves the Inbox and lands in Archive', async () => {
    const id = await importEmail({
      body: 'Accepted from the attendee calendar.',
      from: 'Calendar Bot <calendar@example.com>',
      keywords: {},
      receivedAt: new Date(run),
      subject: 'Accepted: sync',
    })
    const result = await archiveEmails(deps, { args: { ids: [id] }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Archived 1 message(s).')
    expect(await mailboxesOf(id)).toEqual([archiveId])
  })

  test('move_emails replaces the folder set with the destination', async () => {
    const id = await importEmail({
      body: 'Please file this.',
      from: 'Ada Example <ada@example.com>',
      keywords: {},
      receivedAt: new Date(run),
      subject: 'Project kickoff',
    })
    const result = await moveEmails(deps, { args: { ids: [id], mailbox: 'projects' }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(await mailboxesOf(id)).toEqual([projectsId])
  })

  test('move_emails refuses the trash-role mailbox under its server-side name', async () => {
    const id = await importEmail({
      body: 'Keep me.',
      from: 'Ada Example <ada@example.com>',
      keywords: {},
      receivedAt: new Date(run),
      subject: 'Not a delete',
    })
    // Stock Stalwart names its trash-role mailbox "Deleted Items": not a place
    // name, so this exercises the name lookup → resolved-id refusal, not the
    // place-name short-circuit.
    const result = await moveEmails(deps, { args: { ids: [id], mailbox: 'Deleted Items' }, token: TOKEN })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('trash_emails')
    expect(await mailboxesOf(id)).toEqual([inboxId])
  })

  test('trash_emails lands in Trash and a stale id is reported, not thrown', async () => {
    const id = await importEmail({
      body: 'Delete me.',
      from: 'Noise <noise@example.com>',
      keywords: {},
      receivedAt: new Date(run),
      subject: 'Spam-ish',
    })
    const result = await trashEmails(deps, { args: { ids: [id, 'zz-does-not-exist'] }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Trashed 1 message(s).')
    // RFC 8620 §5.3: an unknown id in `update` is refused as `notFound`.
    expect(result.content[0]?.text).toContain('zz-does-not-exist (notFound)')
    expect(await mailboxesOf(id)).toEqual([trashId])
  })

  test('mark_emails flips $seen both ways, idempotently, without moving the message', async () => {
    const id = await importEmail({
      body: 'Read me later.',
      from: 'Ada Example <ada@example.com>',
      keywords: {},
      receivedAt: new Date(run),
      subject: 'Weekly notes',
    })
    expect(await isSeen(id)).toBe(false)
    for (const _ of [1, 2]) {
      const read = await markEmails(deps, { args: { as: 'read', ids: [id] }, token: TOKEN })
      expect(read.content[0]?.text).toBe('Marked 1 message(s) as read.')
      expect(await isSeen(id)).toBe(true)
    }
    const unread = await markEmails(deps, { args: { as: 'unread', ids: [id] }, token: TOKEN })
    expect(unread.content[0]?.text).toBe('Marked 1 message(s) as unread.')
    expect(await isSeen(id)).toBe(false)
    expect(await mailboxesOf(id)).toEqual([inboxId])
  })
})
