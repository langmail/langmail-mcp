// E2E for the mail-rules tools against a REAL Stalwart: every tool
// (preview, create, list, update, delete) is driven end to end through the
// live store (SieveScript blobs over JMAP) and the live existing-mail
// applier (Email/query + Email/set). Because SieveScript/set runs
// Stalwart's Sieve compiler, the create/update tests also prove the
// generated scripts are valid Sieve — including a kitchen-sink rule
// covering every condition and action type.
//
// Seeding is deterministic and in-process: raw RFC 5322 messages are
// uploaded and Email/import-ed into the Inbox (no SMTP timing).
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password. The
// store/applier `authorize` seam pins the Basic credential while
// everything downstream is the same live path production runs.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test mail-rules-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  blobDownload,
  emailGet,
  emailQueryFilter,
  mailboxCreate,
  mailboxIdByRole,
  makeJmapLive,
  sieveScriptList,
} from '../jmap/index.ts'
import { untilIndexed } from '../search-index-test-wait.ts'
import { createMailRule, createMailRuleInput } from '../tools/create-mail-rule.ts'
import { deleteMailRule } from '../tools/delete-mail-rule.ts'
import { listMailRules } from '../tools/list-mail-rules.ts'
import { type MailRuleToolDeps } from '../tools/mail-rule-common.ts'
import { previewMailRule, previewMailRuleInput } from '../tools/preview-mail-rule.ts'
import { updateMailRule, updateMailRuleInput } from '../tools/update-mail-rule.ts'
import { makeLiveApplyIo, makeMailRulesApplier } from './apply.ts'
import { RULES_SCRIPT_NAME } from './rule.ts'
import { makeLiveSieveIo, makeMailRulesStore } from './store.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the authorize seam pins Basic auth (see header)

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

const RULE_ID_RE = /\[(rule-[0-9a-f]{8})\]/u
const KITCHEN_RULE_ID_RE = /\[(rule-[0-9a-f]{8})\] Kitchen sink/u

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

live('mail rules against live Stalwart — preview/create/list/update/delete', () => {
  const run = Date.now()
  const localPart = `mcp-rules-e2e-${run}`
  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let downloadUrl: string
  let inboxId: string
  let deps: MailRuleToolDeps
  let githubIds: string[] = []
  let otherId: string

  const message = (subject: string, from: string, index: number): string =>
    [
      `From: Notifications <${from}>`,
      `To: ${address}`,
      `Subject: ${subject}`,
      `Message-ID: <${index}-${run}@mcp-rules-e2e>`,
      'Date: Tue, 21 Jul 2026 10:00:00 +0000',
      '',
      `Body of ${subject}.`,
    ].join('\r\n')

  const importEmail = async (uploadUrl: string, raw: string): Promise<string> => {
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
              emails: { i0: { blobId, mailboxIds: { [inboxId]: true }, receivedAt: '2026-07-21T10:00:00Z' } },
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

  const managedScript = async (): Promise<{ blobId: string; id: string; isActive: boolean } | undefined> => {
    const scripts = await sieveScriptList({ accountId, apiUrl, authorization })
    return scripts.find((s) => s.name === RULES_SCRIPT_NAME)
  }

  const scriptContent = async (blobId: string): Promise<string> => {
    const res = await blobDownload({
      accountId,
      authorization,
      blobId,
      downloadUrl,
      name: 'rules.sieve',
      type: 'application/sieve',
    })
    return res.text()
  }

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run 'bun run stalwart:setup' first`)
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
      create: { ap1: { allowedIps: {}, description: 'mcp rules e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`

    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string; downloadUrl: string; uploadUrl: string }
    apiUrl = session.apiUrl
    downloadUrl = session.downloadUrl
    const jmapLive = makeJmapLive(ADMIN_URL as string)
    accountId = await jmapLive.resolveAccountId(authorization)

    const ctx = { accountId, apiUrl, authorization }
    inboxId =
      (await mailboxIdByRole({ ...ctx, role: 'inbox' })) ??
      (await mailboxCreate({ ...ctx, name: 'Inbox', role: 'inbox' }))

    githubIds = [
      await importEmail(session.uploadUrl, message('PR #1 opened', 'notifications@github.com', 1)),
      await importEmail(session.uploadUrl, message('PR #2 opened', 'notifications@github.com', 2)),
    ]
    otherId = await importEmail(session.uploadUrl, message('Lunch on Friday?', 'friend@example.com', 3))
    // The preview and the backfill both query the index, so the seed is awaited.
    await untilIndexed(
      () => emailQueryFilter({ ...ctx, filter: { from: 'notifications@github.com' }, limit: 10 }),
      (found) => githubIds.every((id) => found.includes(id)),
      'the seeded GitHub notifications'
    )

    // Live deps with the Basic credential pinned at the authorize seam.
    const authorize = (): string => authorization
    deps = {
      applier: makeMailRulesApplier(makeLiveApplyIo(jmapLive, authorize)),
      store: makeMailRulesStore(makeLiveSieveIo(jmapLive, authorize)),
    }
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its mail data. Always
    // query by name (never gate on late-assigned state) so a beforeAll that
    // failed after account creation still cleans up on the shared dev compose.
    const query = await adminCall('x:Account/query', { filter: { name: localPart } })
    const ids = (query.ids as string[] | undefined) ?? []
    if (ids.length > 0) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  const githubRuleArgs = {
    actions: [{ type: 'archive' as const }, { tag: 'GitHub', type: 'addTag' as const }, { type: 'markRead' as const }],
    conditions: { from: 'notifications@github.com' },
    name: 'Archive GitHub Notifications',
  }

  test('preview_mail_rule estimates the seeded matches and installs nothing', async () => {
    const result = await previewMailRule(deps, {
      args: previewMailRuleInput.parse({ ...githubRuleArgs, existingMail: { mode: 'messages', scope: 'inbox' } }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Rule is valid.')
    expect(txt).toContain('Approximately 2 existing Inbox message(s) match (2 conversation(s)).')
    expect(await managedScript()).toBeUndefined()
  })

  test('create_mail_rule installs an active Sieve script and backfills existing Inbox mail', async () => {
    const result = await createMailRule(deps, {
      args: createMailRuleInput.parse({ ...githubRuleArgs, existingMail: { mode: 'messages', scope: 'inbox' } }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Mail rule created')
    expect(txt).toContain('Applied to existing mail: 2 messages matched, 2 modified.')

    // Stalwart accepted (= compiled) and activated the generated script.
    const script = await managedScript()
    expect(script).toBeDefined()
    expect(script?.isActive).toBe(true)
    const content = await scriptContent(script?.blobId ?? '')
    expect(content).toContain('# langmail-rule ')
    expect(content).toContain('fileinto :specialuse "\\\\Archive" :create "Archive";')

    // The backfill really moved/tagged/read the matching messages …
    const patched = await emailGet({ accountId, apiUrl, authorization, ids: githubIds })
    for (const email of patched) {
      expect(email.keywords?.['$label:github']).toBe(true)
      expect(email.keywords?.$seen).toBe(true)
      expect(email.mailboxIds?.[inboxId]).toBeUndefined()
    }
    // … and left the non-matching message alone.
    const [other] = await emailGet({ accountId, apiUrl, authorization, ids: [otherId] })
    expect(other?.mailboxIds?.[inboxId]).toBe(true)
    expect(other?.keywords?.['$label:github']).toBeUndefined()
  })

  test('list_mail_rules shows the installed rule with its id and state', async () => {
    const result = await listMailRules(deps, TOKEN)
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('1 mail rule(s)')
    expect(txt).toContain('Archive GitHub Notifications')
    expect(txt).toMatch(RULE_ID_RE)
    expect(txt).toContain('sender contains "notifications@github.com"')
  })

  test('update_mail_rule disables the rule in place and the script drops its executable block', async () => {
    const listed = (await listMailRules(deps, TOKEN)).content[0]?.text ?? ''
    const ruleId = listed.match(RULE_ID_RE)?.[1] as string

    const result = await updateMailRule(deps, {
      args: updateMailRuleInput.parse({ enabled: false, name: 'GitHub (paused)', ruleId }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('GitHub (paused) (disabled)')

    const script = await managedScript()
    const content = await scriptContent(script?.blobId ?? '')
    expect(content).toContain('"enabled":false')
    expect(content).not.toContain('if allof')

    const relisted = (await listMailRules(deps, TOKEN)).content[0]?.text ?? ''
    expect(relisted).toContain('GitHub (paused) (disabled)')
  })

  test('a kitchen-sink rule with every condition and action type compiles on the server', async () => {
    const result = await createMailRule(deps, {
      args: createMailRuleInput.parse({
        actions: [
          { tag: 'Kitchen Sink', type: 'addTag' },
          { tag: 'old', type: 'removeTag' },
          { type: 'markRead' },
          { type: 'markUnread' },
          { type: 'flag' },
          { mailbox: 'Backup', type: 'copy' },
          { mailbox: 'Sink', type: 'move' },
          { to: 'oncall@example.com', type: 'forward' },
          { type: 'stopProcessing' },
        ],
        conditions: {
          bodyContains: 'wire transfer',
          from: 'acme.example',
          hasAttachment: true,
          subject: 'contract',
          to: 'legal@',
        },
        match: 'any',
        name: 'Kitchen sink',
      }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    // SieveScript/set would have rejected an invalid script — reaching an
    // active managed script with 2 rules proves the full vocabulary compiles.
    expect((await managedScript())?.isActive).toBe(true)
    const listed = (await listMailRules(deps, TOKEN)).content[0]?.text ?? ''
    expect(listed).toContain('2 mail rule(s)')

    const kitchenId = listed.match(KITCHEN_RULE_ID_RE)?.[1] as string
    const deleted = await deleteMailRule(deps, { args: { ruleId: kitchenId }, token: TOKEN })
    expect(deleted.isError).toBeUndefined()
  })

  test('delete_mail_rule removes the last rule and the managed script carries none', async () => {
    const listed = (await listMailRules(deps, TOKEN)).content[0]?.text ?? ''
    const ruleId = listed.match(RULE_ID_RE)?.[1] as string

    const result = await deleteMailRule(deps, { args: { ruleId }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain(ruleId)

    expect((await listMailRules(deps, TOKEN)).content[0]?.text).toContain('No mail rules configured')
    const script = await managedScript()
    const content = await scriptContent(script?.blobId ?? '')
    expect(content).not.toContain('# langmail-rule ')
  })
})
