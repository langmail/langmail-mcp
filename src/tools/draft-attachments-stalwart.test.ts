// E2E for draft attachments (issue #628) against a REAL Stalwart: stage a
// generated file onto a draft, forward one that is already in the mailbox by
// blobId, edit the draft without losing either, and send it — asserting at each
// step that the bytes Stalwart holds are the bytes the fixture started with.
//
// Every claim this feature makes is a claim about the server, which is why the
// test is here and not against a mock. That `blobUpload` returns a handle
// `Email/set` will accept as an `attachments` entry. That a blobId lifted off a
// *received* message can be referenced by a *new* one, which is the whole
// forwarding story — nothing is downloaded, nothing is re-uploaded, and the
// bytes never enter the conversation. That an edit re-referencing those blobs
// produces a message whose attachment is still byte-identical, even though
// RFC 8621 made update mean create-and-destroy. And that the file survives
// EmailSubmission all the way into the recipient's Inbox: a draft that carries
// an invoice but delivers a message that doesn't is the failure this whole
// feature would be worth nothing against.
//
// Seeding is deterministic and in-process: the raw RFC 5322 MIME is built from
// the shared attachment fixtures and Email/import-ed into the Inbox, so nothing
// waits on SMTP. Mail is sent to the throwaway account's own address so
// delivery stays local.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password. The tools' deps
// interface is the auth seam: these deps pin the Basic Authorization while
// every wrapper below it is the same live path production runs.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test draft-attachments-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  blobDownload,
  blobUpload,
  draftCreate,
  draftDestroy,
  draftIdResolve,
  draftList,
  type EmailComposeRecord,
  emailComposeGet,
  emailGetDetail,
  emailQuery,
  emailSet,
  emailSubmissionCreate,
  identityGet,
  mailboxCreate,
  mailboxIdByRole,
  makeJmapLive,
  threadMessageFind,
} from '@langmail/jmap'

import { createAttachmentUpload } from '../attachments/upload.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { MAX_ATTACHMENT_BYTES } from '../drafts/attachments.ts'
import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import { createDraft, createDraftInput } from './create-draft.ts'
import { attachmentsFromRecord, type DraftToolDeps } from './draft-common.ts'
import { forwardMessage, forwardMessageInput } from './forward-message.ts'
import { getDraft, getDraftInput } from './get-draft.ts'
import { type GetEmailDeps, getEmail, getEmailInput } from './get-email.ts'
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

const live = ADMIN_URL ? describe : describe.skip

// Tool results are text for a human/agent to read, so the ids the next call
// needs are pulled back out of that text — the same way a client would.
const DRAFT_ID_RE = /draftId: (\S+)/u
const MESSAGE_ID_RE = /messageId: (\S+)/u
// The blobId get_email prints for the seeded contract, which is all a forward
// has to go on.
const CONTRACT_LINE_RE = /contract\.pdf — application\/pdf,[^\n]*blobId: (\S+)/u
// The blobId get_draft prints for an attached file, which is the handle an
// update_draft that keeps that file has to pass back.
const DRAFT_BLOB_ID_RE = /blobId: (\S+)/u

// Base64 wrapped at 76 columns, as RFC 2045 §6.8 wants it inside MIME.
const base64Lines = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString('base64')
    .match(/.{1,76}/gu)
    ?.join('\r\n') ?? ''

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

live('draft attachments against live Stalwart — attach, forward, edit, send', () => {
  const run = Date.now()
  const localPart = `mcp-draft-att-e2e-${run}`
  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let downloadUrl: string
  let uploadUrl: string
  let inboxId: string
  let draftsId: string
  let sentId: string
  let deps: DraftToolDeps
  let getEmailDeps: GetEmailDeps
  // The contract that arrives by mail — the "forward that to the lawyer" case.
  let contractBytes: Uint8Array<ArrayBuffer>
  let contractMessageId: string
  // A file the agent generated itself — the motivating invoice case.
  let invoiceBytes: Uint8Array<ArrayBuffer>
  let invoiceBase64: string

  const replays = createIdempotencyStore<string>()
  const guard = createSendGuard()
  const ctx = () => ({ accountId, apiUrl, authorization })
  const toolCtx = { principal: '', token: TOKEN }

  // The message carrying the contract, as it would arrive from a correspondent.
  const contractMime = (pdfB64: string): string =>
    [
      `From: ${CORRESPONDENT}`,
      `To: ${address}`,
      'Subject: Signed contract',
      `Message-ID: <contract-${run}@example.org>`,
      'Date: Tue, 21 Jul 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed-b"',
      '',
      '--mixed-b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Countersigned copy attached.',
      '--mixed-b',
      'Content-Type: application/pdf; name="contract.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="contract.pdf"',
      '',
      pdfB64,
      '--mixed-b--',
      '',
    ].join('\r\n')

  // Test-only ingress: blob upload + Email/import straight into the Inbox —
  // the JMAP equivalent of mail arriving, without needing an SMTP listener.
  const importEmail = async (raw: string): Promise<string> => {
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

  // The bytes Stalwart is actually holding for an attachment part. Every
  // "the file survived" assertion in this file goes through here, because a
  // part with the right name and size can still hold the wrong content.
  const attachedBytes = async (blobId: string, name: string, type: string): Promise<Uint8Array> => {
    const res = await blobDownload({ accountId, authorization, blobId, downloadUrl, name, type })
    return new Uint8Array(await res.arrayBuffer())
  }

  // The one attachment part of a message, with its blob fetched.
  const soleAttachment = async (
    emailId: string
  ): Promise<{ bytes: Uint8Array; name: string; size: number; type: string }> => {
    const record = await emailComposeGet({ ...ctx(), id: emailId, maxBodyValueBytes: 10_000 })
    const parts = record?.attachments ?? []
    expect(parts).toHaveLength(1)
    const part = parts[0]
    expect(part?.blobId).toBeTruthy()
    const name = part?.name ?? ''
    const type = part?.type ?? ''
    return {
      bytes: await attachedBytes(part?.blobId ?? '', name, type),
      name,
      size: part?.size ?? 0,
      type,
    }
  }

  // The draftId is a token the draft carries as a keyword; `emailId` is the
  // message it names right now.
  const stage = async (args: Record<string, unknown>): Promise<{ draftId: string; emailId: string; text: string }> => {
    const result = await createDraft(deps, replays, { ...toolCtx, args: createDraftInput.parse(args) })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    const draftId = DRAFT_ID_RE.exec(text)?.[1] ?? ''
    return { draftId, emailId: (await draftIdResolve({ ...ctx(), draftId })) ?? '', text }
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
      create: {
        ap1: { allowedIps: {}, description: 'mcp draft attachments e2e', permissions: { '@type': 'Inherit' } },
      },
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
    uploadUrl = session.uploadUrl
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

    // The same PDF fixture stands in for both files. They travel by completely
    // different routes — one arrives as MIME and is forwarded by handle, the
    // other is uploaded as base64 — so identical starting bytes make a
    // mismatch at the far end unambiguous.
    contractBytes = new Uint8Array(
      await Bun.file(new URL('../attachments/fixtures/sample.pdf', import.meta.url)).arrayBuffer()
    )
    invoiceBytes = contractBytes
    invoiceBase64 = Buffer.from(invoiceBytes).toString('base64')
    contractMessageId = await importEmail(contractMime(base64Lines(contractBytes)))

    // Live deps with the Basic credential pinned in place of a Bearer token.
    deps = {
      blobUpload: (p) => blobUpload({ ...p, authorization, uploadUrl }),
      draftCreate: (p) => draftCreate({ ...p, apiUrl, authorization }),
      draftDestroy: (p) => draftDestroy({ ...p, apiUrl, authorization }),
      draftIdResolve: (p) => draftIdResolve({ ...p, apiUrl, authorization }),
      draftList: (p) => draftList({ ...p, apiUrl, authorization }),
      emailComposeGet: (p) => emailComposeGet({ ...p, apiUrl, authorization }),
      emailKeywordsSet: (p) => emailSet({ ...p, apiUrl, authorization }),
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

  // --- acceptance criterion: generate a file, stage a draft carrying it ------

  test('create_draft stages a generated file as a real attachment, in one call', async () => {
    const { draftId, emailId, text } = await stage({
      attachments: [{ content: invoiceBase64, filename: 'RE-2026-006.pdf' }],
      subject: 'Corrected invoice',
      text: 'The corrected invoice is attached.',
      to: [CORRESPONDENT],
    })
    expect(draftId).not.toBe('')
    // The tool told the agent what it staged, so the user can be told too.
    expect(text).toContain('attachments (1):')
    expect(text).toContain('RE-2026-006.pdf')

    // Stalwart filed it as an unsent draft…
    const record = await emailComposeGet({ ...ctx(), id: emailId, maxBodyValueBytes: 10_000 })
    expect(record?.keywords?.$draft).toBe(true)
    expect(record?.mailboxIds?.[draftsId]).toBe(true)
    expect(record?.hasAttachment).toBe(true)

    // …carrying a part whose name, media type, size, and bytes are all the
    // file the agent handed over. Size and bytes both, because a truncated or
    // re-encoded upload still has the right name.
    const attachment = await soleAttachment(emailId)
    expect(attachment.name).toBe('RE-2026-006.pdf')
    expect(attachment.type).toBe('application/pdf')
    expect(attachment.size).toBe(invoiceBytes.byteLength)
    expect(attachment.bytes).toEqual(invoiceBytes)
  })

  // --- acceptance criterion: re-attach by blobId, without downloading it -----

  test('an attachment already in the mailbox is forwarded by blobId alone', async () => {
    // Everything the agent has to go on is what get_email printed — the same
    // blobId a human-facing client would see. The bytes are never fetched.
    const read = await getEmail(getEmailDeps, { args: getEmailInput.parse({ id: contractMessageId }), token: TOKEN })
    expect(read.isError).toBeUndefined()
    const contractBlobId = CONTRACT_LINE_RE.exec(read.content[0]?.text ?? '')?.[1] ?? ''
    expect(contractBlobId).not.toBe('')

    const { emailId } = await stage({
      attachments: [{ blobId: contractBlobId, filename: 'contract.pdf', mimeType: 'application/pdf' }],
      subject: 'Fwd: Signed contract',
      text: 'Forwarding the countersigned copy.',
      to: ['lawyer@example.org'],
    })

    const attachment = await soleAttachment(emailId)
    expect(attachment.name).toBe('contract.pdf')
    expect(attachment.type).toBe('application/pdf')
    // The forwarded part is the file that arrived, byte for byte, having made
    // no round trip through this process.
    expect(attachment.bytes).toEqual(contractBytes)
  })

  // --- a local file, uploaded through the capability URL (issue #850) -------

  test('a file PUT to an upload URL attaches by the blobId the upload returns', async () => {
    // The route as production wires it, with the Basic credential pinned on
    // the ticket where a Bearer would be.
    const uploadTickets = createUploadTicketStore()
    const upload = createAttachmentUpload(
      {
        getSession: () => Promise.resolve({ apiUrl, downloadUrl, primaryAccounts: {}, uploadUrl }),
        resolveAccountId: () => Promise.resolve(accountId),
      },
      uploadTickets
    )
    const { token } = uploadTickets.mint({
      accountId,
      authorization,
      // No extension to guess from: the media type survives only if the
      // entry the upload hands back carries it.
      filename: 'Bescheid-2025',
      type: 'application/pdf',
    })

    // Streamed in uneven chunks, the way curl -T sends a file from disk.
    const third = Math.ceil(invoiceBytes.byteLength / 3)
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (let offset = 0; offset < invoiceBytes.byteLength; offset += third) {
          controller.enqueue(invoiceBytes.slice(offset, offset + third))
        }
        controller.close()
      },
    })
    const res = await upload(token, new Request('http://mcp.test/attachments/uploads/t', { body, method: 'PUT' }))
    expect(res.status).toBe(200)
    const uploaded = (await res.json()) as { blobId: string; filename: string; mimeType: string; size: number }
    expect(uploaded.size).toBe(invoiceBytes.byteLength)

    // Attached with exactly the entry the upload response describes.
    const { draftId, emailId } = await stage({
      attachments: [{ blobId: uploaded.blobId, filename: uploaded.filename, mimeType: uploaded.mimeType }],
      subject: 'Steuerbescheide',
      text: 'The notice is attached.',
      to: [CORRESPONDENT],
    })

    // The person reviewing the draft sees the file before it is sent…
    const read = await getDraft(deps, { args: getDraftInput.parse({ draftId }), token: TOKEN })
    expect(read.content[0]?.text).toContain('Bescheid-2025 — application/pdf')
    // …and it is the file that left the disk, byte for byte.
    const attachment = await soleAttachment(emailId)
    expect(attachment.name).toBe('Bescheid-2025')
    expect(attachment.type).toBe('application/pdf')
    expect(attachment.bytes).toEqual(invoiceBytes)
  })

  // --- acceptance criterion: get_draft shows what is attached ---------------

  test('get_draft reports the attached file and the blobId an edit would need', async () => {
    const { draftId } = await stage({
      attachments: [{ content: invoiceBase64, filename: 'RE-2026-007.pdf' }],
      subject: 'For review',
      text: 'Please check the attached invoice.',
      to: [CORRESPONDENT],
    })

    const result = await getDraft(deps, { args: getDraftInput.parse({ draftId }), token: TOKEN })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Draft (not sent):')
    expect(text).toContain('attachments (1):')
    expect(text).toContain('RE-2026-007.pdf — application/pdf')
    // The blobId is the handle update_draft needs to keep this file, so it has
    // to be a real one Stalwart will accept — not a partId or a placeholder.
    const blobId = DRAFT_BLOB_ID_RE.exec(text)?.[1] ?? ''
    expect(blobId).not.toBe('')
    expect(await attachedBytes(blobId, 'RE-2026-007.pdf', 'application/pdf')).toEqual(invoiceBytes)
  })

  // --- editing an attached draft -------------------------------------------

  test('update_draft rewrites the message and keeps the file it never mentioned', async () => {
    const { draftId, emailId } = await stage({
      attachments: [{ content: invoiceBase64, filename: 'RE-2026-008.pdf' }],
      subject: 'Invoice',
      text: 'Draft body.',
      to: [CORRESPONDENT],
    })

    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ draftId, subject: 'Invoice RE-2026-008 (corrected)' }),
      ...toolCtx,
    })
    expect(result.isError).toBeUndefined()
    expect(DRAFT_ID_RE.exec(result.content[0]?.text ?? '')?.[1]).toBe(draftId)
    const updatedId = (await draftIdResolve({ ...ctx(), draftId })) ?? ''

    // The edit is create-then-destroy (RFC 8621 §4.6), so this is a different
    // message — behind the same draftId — that happens to reference the same blob. Losing the file here
    // would be unrecoverable — the original is already gone.
    const inDrafts = await idsIn(draftsId)
    expect(inDrafts).toContain(updatedId)
    expect(updatedId).not.toBe(emailId)
    expect(inDrafts).not.toContain(emailId)

    const attachment = await soleAttachment(updatedId)
    expect(attachment.name).toBe('RE-2026-008.pdf')
    expect(attachment.bytes).toEqual(invoiceBytes)
  })

  test('update_draft replaces the whole attachment list when one is given', async () => {
    const { draftId } = await stage({
      attachments: [{ content: invoiceBase64, filename: 'old.pdf' }],
      subject: 'Swap the file',
      text: 'Body.',
      to: [CORRESPONDENT],
    })

    const swapped = await updateDraft(deps, {
      args: updateDraftInput.parse({
        attachments: [{ content: Buffer.from('replacement note').toString('base64'), filename: 'note.txt' }],
        draftId,
      }),
      ...toolCtx,
    })
    expect(swapped.isError).toBeUndefined()
    const swappedId = (await draftIdResolve({ ...ctx(), draftId })) ?? ''

    const attachment = await soleAttachment(swappedId)
    expect(attachment.name).toBe('note.txt')
    expect(attachment.type).toBe('text/plain')
    expect(Buffer.from(attachment.bytes).toString()).toBe('replacement note')

    // …and an empty list takes the file off entirely.
    const cleared = await updateDraft(deps, {
      args: updateDraftInput.parse({ attachments: [], draftId }),
      ...toolCtx,
    })
    expect(cleared.isError).toBeUndefined()
    const clearedId = (await draftIdResolve({ ...ctx(), draftId })) ?? ''
    const record = await emailComposeGet({ ...ctx(), id: clearedId, maxBodyValueBytes: 10_000 })
    expect(record?.attachments ?? []).toHaveLength(0)
    expect(record?.hasAttachment ?? false).toBe(false)
  })

  // --- roundtrip through send_draft ----------------------------------------

  test('a staged attachment survives submission and arrives in the recipient’s Inbox', async () => {
    const before = await idsIn(inboxId)
    // Addressed to the account itself so delivery stays inside the dev server.
    const { draftId } = await stage({
      attachments: [{ content: invoiceBase64, filename: 'RE-2026-009.pdf' }],
      subject: 'Invoice for June',
      text: 'Invoice attached.',
      to: [address],
    })

    const sent = await sendDraft(deps, replays, guard, { ...toolCtx, args: sendDraftInput.parse({ draftId }) })
    expect(sent.isError).toBeUndefined()
    const sentText = sent.content[0]?.text ?? ''
    expect(sentText).toContain('Sent.')
    // The send report names the file, so "what went out" is answerable from the
    // one call that made it irreversible.
    expect(sentText).toContain('RE-2026-009.pdf')

    // The Sent copy — the user's own record — still holds the file.
    const messageId = MESSAGE_ID_RE.exec(sentText)?.[1] ?? ''
    const sentCopy = await soleAttachment(messageId)
    expect(sentCopy.bytes).toEqual(invoiceBytes)

    // The delivered copy is a different Email, assembled and transmitted by the
    // MTA. This is the assertion the feature actually lives or dies on.
    const delivered = await awaitDelivery(inboxId, before)
    expect(delivered.length).toBeGreaterThan(0)
    const deliveredId = delivered[0] ?? ''
    const arrived = await soleAttachment(deliveredId)
    expect(arrived.name).toBe('RE-2026-009.pdf')
    expect(arrived.type).toBe('application/pdf')
    expect(arrived.bytes).toEqual(invoiceBytes)
  })

  // --- forward_message: one call, the original's file and thread (#1201) -----

  test('forward_message carries the original file into the recipient’s Inbox and threads with the original', async () => {
    const before = await idsIn(inboxId)
    const result = await forwardMessage(deps, replays, guard, {
      ...toolCtx,
      args: forwardMessageInput.parse({ messageId: contractMessageId, text: 'For your records.', to: [address] }),
    })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Forward sent.')
    expect(text).toContain('contract.pdf')
    expect(text).not.toContain('could not be marked')

    // The Sent copy holds the file, by the blob it was forwarded from, and
    // sits in the original's conversation.
    const messageId = MESSAGE_ID_RE.exec(text)?.[1] ?? ''
    expect((await soleAttachment(messageId)).bytes).toEqual(contractBytes)
    const sentCopy = await emailComposeGet({ ...ctx(), bodyValues: 'body', id: messageId, maxBodyValueBytes: 10_000 })
    const original = await emailComposeGet({ ...ctx(), id: contractMessageId, maxBodyValueBytes: 1 })
    expect(sentCopy?.threadId).toBe(original?.threadId ?? '')
    expect(sentCopy?.subject).toBe('Fwd: Signed contract')
    expect(original?.keywords?.$forwarded).toBe(true)

    // And it arrives, file and forwarded header block included.
    const delivered = await awaitDelivery(inboxId, before)
    const arrivedId = delivered[0] ?? ''
    expect((await soleAttachment(arrivedId)).bytes).toEqual(contractBytes)
    const arrived = await emailComposeGet({ ...ctx(), bodyValues: 'body', id: arrivedId, maxBodyValueBytes: 10_000 })
    const body = Object.values(arrived?.bodyValues ?? {})
      .map((value) => value.value)
      .join('\n')
    expect(body).toContain('For your records.')
    expect(body).toContain('---------- Forwarded message ---------')
    expect(body).toContain('Countersigned copy attached.')
  })

  test('a staged forward of a photo inline in the body keeps it through an edit of the note', async () => {
    const pixel = Buffer.from(
      await Bun.file(new URL('../attachments/fixtures/pixel.png', import.meta.url)).arrayBuffer()
    ).toString('base64')
    // The Apple Mail shape: text, an inline image, more text, in one multipart/mixed.
    const photoId = await importEmail(
      [
        `From: ${CORRESPONDENT}`,
        `To: ${address}`,
        'Subject: Photo of the meter',
        `Message-ID: <photo-${run}@example.org>`,
        'Date: Tue, 21 Jul 2026 11:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="m"',
        '',
        '--m',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Here is the meter:',
        '--m',
        'Content-Type: image/png; name="meter.png"',
        'Content-Disposition: inline; filename="meter.png"',
        'Content-Transfer-Encoding: base64',
        '',
        pixel,
        '--m',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Reading as of today.',
        '--m--',
        '',
      ].join('\r\n')
    )
    const images = (record: EmailComposeRecord | null): number =>
      attachmentsFromRecord(record ?? { id: '' }).filter((file) => file.type === 'image/png').length
    const { draftId, emailId } = await stage({ forwardOf: photoId, to: ['caretaker@example.org'] })
    expect(images(await emailComposeGet({ ...ctx(), id: emailId, maxBodyValueBytes: 10_000 }))).toBe(1)

    const edited = await updateDraft(deps, {
      ...toolCtx,
      args: updateDraftInput.parse({ draftId, text: 'See below.' }),
    })
    expect(edited.isError).toBeUndefined()
    const current = (await draftIdResolve({ ...ctx(), draftId })) ?? ''
    const revision = await emailComposeGet({ ...ctx(), id: current, maxBodyValueBytes: 10_000 })
    expect(images(revision)).toBe(1)
  })

  // --- refusals -------------------------------------------------------------

  test('an oversized attachment is refused up front, with nothing staged', async () => {
    const before = await idsIn(draftsId)
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024).toString('base64')
    const result = await createDraft(deps, replays, {
      ...toolCtx,
      args: createDraftInput.parse({
        attachments: [{ content: oversized, filename: 'huge.bin' }],
        subject: 'Too big',
        text: 'Body.',
        to: [CORRESPONDENT],
      }),
    })
    expect(result.isError).toBe(true)
    // Named number, and the refusal comes from us rather than from a submission
    // failure hours later.
    expect(result.content[0]?.text ?? '').toContain('25 MB')
    expect(await idsIn(draftsId)).toEqual(before)
  })

  test('an unknown blobId is refused by the server, and no draft is left behind', async () => {
    const before = await idsIn(draftsId)
    const result = await createDraft(deps, replays, {
      ...toolCtx,
      args: createDraftInput.parse({
        attachments: [{ blobId: 'Gnot-a-real-blob', filename: 'ghost.pdf' }],
        subject: 'Ghost file',
        text: 'Body.',
        to: [CORRESPONDENT],
      }),
    })
    // Stalwart answers `blobNotFound` and names nothing further, so the tool
    // has to supply the diagnosis the agent can act on — a bare error code
    // would leave it with no next move.
    expect(result.isError).toBe(true)
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('blobId')
    expect(text).toContain('Nothing was staged')
    // And what must not happen: a draft staged that silently lost its file.
    expect(await idsIn(draftsId)).toEqual(before)
  })
})
