// E2E for the composition tools against a REAL Stalwart: create_draft,
// get_draft, update_draft, send_draft, and reply_to_message driven end to end
// over live JMAP.
//
// This is the test that actually proves the feature, because every interesting
// claim it makes is a claim about the server. That Email/set `create` with
// bodyValues produces a message Stalwart files as a draft; that create+destroy
// in one call really replaces a draft rather than duplicating it; that
// Identity/get returns something to send as; that EmailSubmission/set accepts a
// staged draft and that its `onSuccessUpdateEmail` moves the message into Sent
// and clears `$draft`. None of that is observable against a mock.
//
// The two acceptance criteria are asserted directly: a threaded reply staged
// from a contact's message and visible in Drafts (phase 1), and that same draft
// sent, returning an id that get_email reads back in the same session (phase 2).
//
// Seeding is deterministic and in-process: a raw RFC 5322 message is uploaded
// and Email/import-ed into the Inbox (no SMTP timing). Mail is sent to the
// throwaway account's own address so delivery stays local.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password, so the deps are
// constructed with that credential pinned while every wrapper below it is the
// same live path production runs.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test drafts-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  blobDownload,
  blobUpload,
  draftCreate,
  draftIdResolve,
  draftList,
  emailComposeGet,
  emailGetDetail,
  emailQuery,
  emailSubmissionCreate,
  identityGet,
  mailboxCreate,
  mailboxIdByRole,
  makeJmapLive,
  threadMessageFind,
} from '@langmail/jmap'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import { createDraft, createDraftInput } from './create-draft.ts'
import { type DraftToolDeps } from './draft-common.ts'
import { getDraft, getDraftInput } from './get-draft.ts'
import { type GetEmailDeps, getEmail, getEmailInput } from './get-email.ts'
import { listDrafts, listDraftsInput } from './list-drafts.ts'
import { replyToMessage, replyToMessageInput } from './reply-to-message.ts'
import { sendDraft, sendDraftInput } from './send-draft.ts'
import { updateDraft, updateDraftInput } from './update-draft.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

// An invented correspondent at a reserved domain (AGENTS.md: no real people,
// and the address provably cannot resolve).
const CORRESPONDENT = 'Nadia Bram <nadia@example.org>'
const CORRESPONDENT_ADDRESS = 'nadia@example.org'

const live = ADMIN_URL ? describe : describe.skip

// Tool results are text for a human/agent to read, so the ids the next call
// needs are pulled back out of that text — the same way a client would.
const DRAFT_ID_RE = /draftId: (\S+)/u
const MESSAGE_ID_RE = /messageId: (\S+)/u

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

live('composition tools against live Stalwart — draft, edit, send, reply', () => {
  const run = Date.now()
  const localPart = `mcp-drafts-e2e-${run}`
  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let downloadUrl: string
  let inboxId: string
  let draftsId: string
  let sentId: string
  let deps: DraftToolDeps
  let getEmailDeps: GetEmailDeps
  let originalId: string

  const replays = createIdempotencyStore<string>()
  const guard = createSendGuard()
  const ctx = () => ({ accountId, apiUrl, authorization })
  const toolCtx = { principal: '', token: TOKEN }

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

  const idsIn = (mailboxId: string): Promise<string[]> => emailQuery({ ...ctx(), filters: { mailboxId }, limit: 50 })

  // Local delivery is asynchronous — the submission returns once the message is
  // queued, not once it has landed. Poll rather than assume, so the test fails on
  // a real regression instead of on timing.
  const awaitDelivery = async (mailboxId: string, before: string[]): Promise<string[]> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const fresh = (await idsIn(mailboxId)).filter((id) => !before.includes(id))
      if (fresh.length > 0) {
        return fresh
      }
      await Bun.sleep(100)
    }
    return []
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
      create: { ap1: { allowedIps: {}, description: 'mcp drafts e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`
    toolCtx.principal = address

    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string; downloadUrl: string; uploadUrl: string }
    apiUrl = session.apiUrl
    downloadUrl = session.downloadUrl
    const jmapLive = makeJmapLive(ADMIN_URL as string)
    accountId = await jmapLive.resolveAccountId(authorization)

    inboxId =
      (await mailboxIdByRole({ ...ctx(), role: 'inbox' })) ??
      (await mailboxCreate({ ...ctx(), name: 'Inbox', role: 'inbox' }))
    draftsId =
      (await mailboxIdByRole({ ...ctx(), role: 'drafts' })) ??
      (await mailboxCreate({ ...ctx(), name: 'Drafts', role: 'drafts' }))
    sentId =
      (await mailboxIdByRole({ ...ctx(), role: 'sent' })) ??
      (await mailboxCreate({ ...ctx(), name: 'Sent', role: 'sent' }))

    originalId = await importEmail(
      session.uploadUrl,
      [
        `From: ${CORRESPONDENT}`,
        `To: ${address}`,
        'Subject: Quarterly numbers',
        `Message-ID: <original-${run}@example.org>`,
        'Date: Tue, 21 Jul 2026 10:00:00 +0000',
        '',
        'Could you confirm the Q2 figures?',
      ].join('\r\n')
    )

    // Live deps with the Basic credential pinned in place of a Bearer token.
    deps = {
      blobUpload: (p) => blobUpload({ ...p, authorization, uploadUrl: session.uploadUrl }),
      draftCreate: (p) => draftCreate({ ...p, apiUrl, authorization }),
      draftIdResolve: (p) => draftIdResolve({ ...p, apiUrl, authorization }),
      draftList: (p) => draftList({ ...p, apiUrl, authorization }),
      emailComposeGet: (p) => emailComposeGet({ ...p, apiUrl, authorization }),
      emailSubmissionCreate: (p) => emailSubmissionCreate({ ...p, apiUrl, authorization }),
      identityGet: (p) => identityGet({ ...p, apiUrl, authorization }),
      resolveAccountId: () => Promise.resolve(accountId),
      resolveComposeMailboxes: () => Promise.resolve({ drafts: draftsId, sent: sentId, trash: null }),
      resolveSubmissionAccountId: () => Promise.resolve(accountId),
      threadMessageFind: (p) => threadMessageFind({ ...p, apiUrl, authorization }),
    }
    getEmailDeps = {
      downloadRawMessage: async (p) => {
        const blob = await blobDownload({
          accountId,
          authorization,
          blobId: p.blobId,
          downloadUrl,
          name: 'message.eml',
          type: 'message/rfc822',
        })
        return new Uint8Array(await blob.arrayBuffer())
      },
      emailGetDetail: (p) => emailGetDetail({ ...p, apiUrl, authorization }),
      resolveAccountId: () => Promise.resolve(accountId),
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

  test('the account has a sending identity to compose as', async () => {
    const identities = await identityGet({ ...ctx() })
    // Everything downstream needs one; failing here rather than inside a tool
    // makes a Stalwart that stops auto-provisioning identities obvious.
    expect(identities.length).toBeGreaterThan(0)
    expect(identities.map((i) => i.email.toLowerCase())).toContain(address.toLowerCase())
  })

  // --- acceptance criterion, phase 1 ---------------------------------------

  let replyDraftId = ''
  let replyEmailId = ''

  test('create_draft stages a correctly threaded reply that lands in Drafts unsent', async () => {
    const result = await createDraft(deps, replays, {
      ...toolCtx,
      args: createDraftInput.parse({ inReplyTo: originalId, text: 'Confirmed — the Q2 figures are final.' }),
    })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Nothing has been sent')
    // The recipient was derived from the message being replied to.
    expect(text).toContain(CORRESPONDENT_ADDRESS)
    expect(text).toContain('subject: Re: Quarterly numbers')

    replyDraftId = DRAFT_ID_RE.exec(text)?.[1] ?? ''
    expect(replyDraftId).not.toBe('')
    // The draftId is a token the message carries as a keyword.
    replyEmailId = (await draftIdResolve({ ...ctx(), draftId: replyDraftId })) ?? ''
    expect(replyEmailId).not.toBe('')

    // Stalwart filed it as a draft, in the Drafts mailbox, with the threading
    // headers set — which is what makes it look human-written in the UI.
    const record = await emailComposeGet({ ...ctx(), id: replyEmailId, maxBodyValueBytes: 10_000 })
    expect(record?.keywords?.$draft).toBe(true)
    expect(record?.mailboxIds?.[draftsId]).toBe(true)
    expect(record?.inReplyTo).toEqual([`original-${run}@example.org`])
    expect(record?.references).toEqual([`original-${run}@example.org`])
    expect(record?.to?.[0]?.email).toBe(CORRESPONDENT_ADDRESS)
    expect(await idsIn(draftsId)).toContain(replyEmailId)

    // Stalwart threaded the reply onto the original conversation.
    const [original] = await emailGetDetail({ ...ctx(), ids: [originalId], maxBodyValueBytes: 1 })
    expect(record?.threadId).toBe(original?.threadId)
  })

  test('get_draft reads the staged reply back', async () => {
    const result = await getDraft(deps, { args: getDraftInput.parse({ draftId: replyDraftId }), token: TOKEN })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Draft (not sent):')
    expect(text).toContain('Confirmed — the Q2 figures are final.')
  })

  test('update_draft keeps the draftId: one draft in Drafts, read back by the same id', async () => {
    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ draftId: replyDraftId, subject: 'Re: Quarterly numbers (final)' }),
      ...toolCtx,
    })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).not.toContain('could not be removed')
    expect(DRAFT_ID_RE.exec(text)?.[1]).toBe(replyDraftId)

    // The edit replaced the message rather than leaving two drafts behind: the
    // first revision is gone, and the draftId now names its replacement.
    const inDrafts = await idsIn(draftsId)
    expect(inDrafts).not.toContain(replyEmailId)
    const current = await draftIdResolve({ ...ctx(), draftId: replyDraftId })
    expect(current).not.toBeNull()
    expect(current).not.toBe(replyEmailId)
    expect(inDrafts).toContain(current ?? '')

    const record = await emailComposeGet({ ...ctx(), id: current ?? '', maxBodyValueBytes: 10_000 })
    expect(record?.subject).toBe('Re: Quarterly numbers (final)')
    // The body and the threading survived an edit that named neither.
    expect(record?.inReplyTo).toEqual([`original-${run}@example.org`])

    const read = await getDraft(deps, { args: getDraftInput.parse({ draftId: replyDraftId }), token: TOKEN })
    expect(read.content[0]?.text).toContain('Re: Quarterly numbers (final)')
  })

  test('update_draft rewords a reply and keeps the quoted original below it', async () => {
    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ draftId: replyDraftId, text: 'Confirmed.' }),
      ...toolCtx,
    })
    expect(result.isError).toBeUndefined()
    expect(DRAFT_ID_RE.exec(result.content[0]?.text ?? '')?.[1]).toBe(replyDraftId)

    const current = await draftIdResolve({ ...ctx(), draftId: replyDraftId })
    const record = await emailComposeGet({ ...ctx(), id: current ?? '', maxBodyValueBytes: 10_000 })
    const body = Object.values(record?.bodyValues ?? {})[0]?.value ?? ''
    expect(body.startsWith('Confirmed.')).toBe(true)
    expect(body).not.toContain('the Q2 figures are final')
    expect(body).toContain('wrote:')
    expect(body).toContain('> ')
  })

  test('list_drafts finds the edited reply once, by its draftId, and narrows by recipient', async () => {
    const list = async (args: Record<string, unknown>) =>
      (await listDrafts(deps, { args: listDraftsInput.parse(args), token: TOKEN })).content[0]?.text ?? ''

    const all = await list({})
    // Edits replaced the revision each time, so the draftId appears once.
    expect(all.split(`draftId: ${replyDraftId}`)).toHaveLength(2)
    const current = await draftIdResolve({ ...ctx(), draftId: replyDraftId })
    expect(all).toContain(`messageId: ${current}`)
    expect(all).toContain(`reply to: message ${originalId}`)

    // The nested OR over subject and recipients, and the date window, are
    // conditions Stalwart has to evaluate — the fixture cannot prove them.
    expect(await list({ query: CORRESPONDENT_ADDRESS })).toContain(`draftId: ${replyDraftId}`)
    // A partial address, to hold the description's "substring" promise to the server.
    expect(await list({ query: 'nadia@' })).toContain(`draftId: ${replyDraftId}`)
    expect(await list({ query: '(final)' })).toContain(`draftId: ${replyDraftId}`)
    expect(await list({ query: 'no-such-recipient.example' })).toBe('No drafts matched.')
    expect(await list({ before: '2000-01-01T00:00:00Z' })).toBe('No drafts matched.')
  })

  test('send_draft by the draftId sends the edited revision, once', async () => {
    const current = (await draftIdResolve({ ...ctx(), draftId: replyDraftId })) ?? ''
    const sent = await sendDraft(deps, replays, guard, {
      ...toolCtx,
      args: sendDraftInput.parse({ draftId: replyDraftId }),
    })
    expect(sent.isError).toBeUndefined()
    expect(MESSAGE_ID_RE.exec(sent.content[0]?.text ?? '')?.[1]).toBe(current)

    const again = await sendDraft(deps, replays, guard, {
      ...toolCtx,
      args: sendDraftInput.parse({ draftId: replyDraftId }),
    })
    expect(again.isError).toBe(true)
    expect(again.content[0]?.text).toContain('already been sent')
  })

  // --- acceptance criterion, phase 2 ---------------------------------------

  test('send_draft sends a staged draft and get_email reads it back in the same session', async () => {
    // Addressed to the account itself so delivery stays inside the dev server.
    const staged = await createDraft(deps, replays, {
      ...toolCtx,
      args: createDraftInput.parse({ subject: 'Self test', text: 'Body of the sent message.', to: [address] }),
    })
    const draftId = DRAFT_ID_RE.exec(staged.content[0]?.text ?? '')?.[1] ?? ''
    expect(draftId).not.toBe('')

    const result = await sendDraft(deps, replays, guard, { ...toolCtx, args: sendDraftInput.parse({ draftId }) })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Sent.')

    const messageId = MESSAGE_ID_RE.exec(text)?.[1] ?? ''
    // The Email id survives the move, so the message the draftId named is the
    // sent message.
    expect(messageId).toBe((await draftIdResolve({ ...ctx(), draftId })) ?? '')

    // onSuccessUpdateEmail moved it out of Drafts into Sent and cleared $draft.
    const record = await emailComposeGet({ ...ctx(), id: messageId, maxBodyValueBytes: 10_000 })
    expect(record?.mailboxIds?.[sentId]).toBe(true)
    expect(record?.mailboxIds?.[draftsId]).toBeUndefined()
    expect(record?.keywords?.$draft).toBeUndefined()

    // …and get_email reads the sent message back by that id.
    const read = await getEmail(getEmailDeps, { args: getEmailInput.parse({ id: messageId }), token: TOKEN })
    expect(read.isError).toBeUndefined()
    const body = read.content[0]?.text ?? ''
    expect(body).toContain('Subject: Self test')
    expect(body).toContain('Body of the sent message.')

    // Stalwart generated a Message-ID for the message it assembled. Without one,
    // a reply to this message would derive empty threading headers and silently
    // start a new conversation (`replyThreading` reads `messageId`).
    expect(record?.messageId?.[0]).toBeTruthy()
  })

  test('a bcc recipient is delivered but does not appear in the delivered message', async () => {
    // The claim this pins down is Stalwart's, not the RFC's: omitting the
    // envelope has the server derive rcptTo from To/Cc/Bcc, and stripping the
    // Bcc header from the transmitted copy is then up to the server. If it
    // didn't, every To recipient would see the blind ones — so assert it rather
    // than assume it.
    const before = await idsIn(inboxId)
    const staged = await createDraft(deps, replays, {
      ...toolCtx,
      args: createDraftInput.parse({
        bcc: [address],
        subject: 'Bcc test',
        text: 'Body with a blind recipient.',
        to: [address],
      }),
    })
    const draftId = DRAFT_ID_RE.exec(staged.content[0]?.text ?? '')?.[1] ?? ''
    const sent = await sendDraft(deps, replays, guard, { ...toolCtx, args: sendDraftInput.parse({ draftId }) })
    expect(sent.isError).toBeUndefined()

    // The Sent copy keeps bcc — that copy is the user's own record.
    const sentCopy = await emailComposeGet({
      ...ctx(),
      id: MESSAGE_ID_RE.exec(sent.content[0]?.text ?? '')?.[1] ?? '',
      maxBodyValueBytes: 10_000,
    })
    expect(sentCopy?.bcc?.[0]?.email).toBe(address)

    // The delivered copy is a different Email; it must carry no bcc at all.
    const delivered = await awaitDelivery(inboxId, before)
    expect(delivered.length).toBeGreaterThan(0)
    for (const id of delivered) {
      const record = await emailComposeGet({ ...ctx(), id, maxBodyValueBytes: 10 })
      expect(record?.bcc ?? null).toBeNull()
    }
  })

  test('send_draft refuses to send the same draft twice', async () => {
    const staged = await createDraft(deps, replays, {
      ...toolCtx,
      args: createDraftInput.parse({ subject: 'Once only', text: 'Sent exactly once.', to: [address] }),
    })
    const draftId = DRAFT_ID_RE.exec(staged.content[0]?.text ?? '')?.[1] ?? ''

    const first = await sendDraft(deps, replays, guard, { ...toolCtx, args: sendDraftInput.parse({ draftId }) })
    expect(first.isError).toBeUndefined()

    // No idempotency key involved: the guard is that the message is no longer a
    // draft, which is state Stalwart holds.
    const second = await sendDraft(deps, replays, guard, { ...toolCtx, args: sendDraftInput.parse({ draftId }) })
    expect(second.isError).toBe(true)
    expect(second.content[0]?.text ?? '').toContain('already been sent')
  })

  test('reply_to_message sends a threaded reply in one call', async () => {
    const result = await replyToMessage(deps, replays, guard, {
      ...toolCtx,
      // Replies to the account's own sent message, so the reply is delivered
      // locally and the whole path stays inside the dev server.
      args: replyToMessageInput.parse({ messageId: originalId, text: 'One-shot reply.', to: [address] }),
    })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Reply sent.')

    const messageId = MESSAGE_ID_RE.exec(text)?.[1] ?? ''
    const record = await emailComposeGet({ ...ctx(), id: messageId, maxBodyValueBytes: 10_000 })
    expect(record?.mailboxIds?.[sentId]).toBe(true)
    expect(record?.keywords?.$draft).toBeUndefined()
    expect(record?.inReplyTo).toEqual([`original-${run}@example.org`])
    expect(record?.subject).toBe('Re: Quarterly numbers')
  })

  test('reply_to_message refuses replyAll combined with explicit recipients, sending nothing', async () => {
    const before = await idsIn(sentId)
    const result = await replyToMessage(deps, replays, guard, {
      ...toolCtx,
      args: replyToMessageInput.parse({ messageId: originalId, replyAll: true, text: 'nope', to: [address] }),
    })
    expect(result.isError).toBe(true)
    expect(await idsIn(sentId)).toEqual(before)
  })
})
