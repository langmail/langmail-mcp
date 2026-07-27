// E2E for the attachments feature (F1) against a REAL Stalwart: seed a
// message carrying both a genuine PDF attachment and a cid-inline PNG, then
// drive the real surfaces end to end — get_email's attachments section,
// download_attachment's capability URL, and the /attachments/:token route
// streaming the blob bytes back out — plus the negative paths (tampered
// token, blobId on the wrong message) and the context-hygiene guarantee
// ("bytes never enter the conversation", encoded as a test).
//
// Seeding is deterministic and in-process: build the raw RFC 5322 MIME from
// the fixtures next to this file, upload via the session uploadUrl, then
// Email/import into the Inbox — no SMTP timing.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password. The tools'
// deps interface is the auth seam: these deps pin the Basic Authorization
// while everything downstream (JMAP wire, ticket store, download route) is
// the same live path production runs.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test attachments-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  blobDownload,
  emailGet,
  emailGetDetail,
  emailQuery,
  emailQueryPerTerm,
  mailboxCreate,
  mailboxIdByRole,
  makeJmapLive,
} from '@langmail/jmap'

import { createRoutes, type Routes } from '../handler.ts'
import { type DownloadAttachmentDeps, downloadAttachment } from '../tools/download-attachment.ts'
import { type GetEmailDeps, getEmail } from '../tools/get-email.ts'
import { type SearchEmailsDeps, searchEmails } from '../tools/search-emails.ts'
import { createAttachmentDownload } from './download.ts'
import { createTicketStore, type TicketStore } from './tickets.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const PUBLIC = 'https://mcp.example.com'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

// Base64 runs longer than this are treated as payload leakage into the
// model-visible result — the thing F1 exists to prevent.
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{100,}/u
const DOWNLOAD_URL_RE = /^(https:\/\/\S+\/attachments\/\S+)$/mu
const PDF_LINE_RE = /^\s*\d+\. invoice\.pdf — application\/pdf, 602 B — blobId: (\S+)$/mu
const PNG_LINE_RE = /^\s*\d+\. logo\.png — image\/png, 70 B — inline — blobId: (\S+)$/mu

const live = ADMIN_URL ? describe : describe.skip

describe('attachment metadata line matchers', () => {
  test('match both get_email attachment lines and indented search hit attachment lines', () => {
    expect('1. invoice.pdf — application/pdf, 602 B — blobId: Gpdf'.match(PDF_LINE_RE)?.[1]).toBe('Gpdf')
    expect('   1. invoice.pdf — application/pdf, 602 B — blobId: Gpdf'.match(PDF_LINE_RE)?.[1]).toBe('Gpdf')
  })
})

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

const base64Lines = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString('base64')
    .match(/.{1,76}/gu)
    ?.join('\r\n') ?? ''

live('attachments against live Stalwart — metadata, capability URL, blob streaming', () => {
  const run = Date.now()
  const localPart = `mcp-att-e2e-${run}`
  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let pdfBytes: Uint8Array<ArrayBuffer>
  let withAttachmentsId: string
  let plainId: string
  let emailDeps: GetEmailDeps
  let searchDeps: SearchEmailsDeps
  let dlDeps: DownloadAttachmentDeps
  let tickets: TicketStore
  let routes: Routes

  // The message with both fixture parts: a cid-inline PNG referenced from
  // the HTML body (inside multipart/related) and a genuine PDF document.
  const invoiceMime = (pngB64: string, pdfB64: string): string =>
    [
      'From: Sender <sender@example.com>',
      `To: ${address}`,
      'Subject: Invoice June 2026',
      `Message-ID: <invoice-${run}@mcp-att-e2e>`,
      'Date: Tue, 30 Jun 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed-b"',
      '',
      '--mixed-b',
      'Content-Type: multipart/related; boundary="related-b"',
      '',
      '--related-b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>Invoice attached.</p><img src="cid:logo@langmail"></body></html>',
      '--related-b',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo@langmail>',
      'Content-Disposition: inline; filename="logo.png"',
      '',
      pngB64,
      '--related-b--',
      '--mixed-b',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      '',
      pdfB64,
      '--mixed-b--',
      '',
    ].join('\r\n')

  const plainMime = (): string =>
    [
      'From: Sender <sender@example.com>',
      `To: ${address}`,
      'Subject: No files here',
      `Message-ID: <plain-${run}@mcp-att-e2e>`,
      'Date: Tue, 30 Jun 2026 10:05:00 +0000',
      '',
      'Just text.',
    ].join('\r\n')

  // Test-only ingress: blob upload + Email/import straight into the Inbox —
  // the JMAP equivalent of mail arriving, without needing an SMTP listener.
  const importEmail = async (uploadUrl: string, inboxId: string, raw: string): Promise<string> => {
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
              emails: { i0: { blobId, mailboxIds: { [inboxId]: true }, receivedAt: '2026-06-30T10:00:00Z' } },
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

    // Throwaway account + app password (the Basic credential over HTTP).
    const created = await adminCall('x:Account/set', {
      create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
    })
    const account = (created.created as { a1?: { id?: string } } | undefined)?.a1
    if (!account?.id) {
      throw new Error(`account not created: ${JSON.stringify(created)}`)
    }
    const stalwartAccountId = account.id
    const minted = await adminCall('x:AppPassword/set', {
      accountId: stalwartAccountId,
      create: { ap1: { allowedIps: {}, description: 'mcp attachments e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`

    // The full session document (not the trimmed fetchSession) — the import
    // helper needs uploadUrl.
    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string; downloadUrl: string; uploadUrl: string }
    apiUrl = session.apiUrl
    const jmapLive = makeJmapLive(ADMIN_URL as string)
    accountId = await jmapLive.resolveAccountId(authorization)

    const ctx = { accountId, apiUrl, authorization }
    const inboxId =
      (await mailboxIdByRole({ ...ctx, role: 'inbox' })) ??
      (await mailboxCreate({ ...ctx, name: 'Inbox', role: 'inbox' }))

    pdfBytes = new Uint8Array(await Bun.file(new URL('./fixtures/sample.pdf', import.meta.url)).arrayBuffer())
    const pngBytes = new Uint8Array(await Bun.file(new URL('./fixtures/pixel.png', import.meta.url)).arrayBuffer())
    withAttachmentsId = await importEmail(
      session.uploadUrl,
      inboxId,
      invoiceMime(base64Lines(pngBytes), base64Lines(pdfBytes))
    )
    plainId = await importEmail(session.uploadUrl, inboxId, plainMime())

    // Live deps with the Basic credential pinned at the deps seam (see header).
    emailDeps = {
      downloadRawMessage: async (p) => {
        const raw = await blobDownload({
          ...p,
          authorization,
          downloadUrl: session.downloadUrl,
          name: 'message.eml',
          type: 'message/rfc822',
        })
        return new Uint8Array(await raw.arrayBuffer())
      },
      emailGetDetail: (p) => emailGetDetail({ ...p, apiUrl, authorization }),
      resolveAccountId: () => Promise.resolve(accountId),
    }
    searchDeps = {
      emailGet: (p) => emailGet({ ...p, apiUrl, authorization }),
      emailQuery: (p) => emailQuery({ ...p, apiUrl, authorization }),
      emailQueryPerTerm: (p) => emailQueryPerTerm({ ...p, apiUrl, authorization }),
      resolveAccountId: () => Promise.resolve(accountId),
      resolveMailbox: () => Promise.resolve({ available: [], id: null }),
    }
    tickets = createTicketStore()
    dlDeps = {
      emailGetDetail: (p) => emailGetDetail({ ...p, apiUrl, authorization }),
      mintTicket: (input) => tickets.mint({ ...input, authorization }),
      publicUrl: PUBLIC,
      resolveAccountId: () => Promise.resolve(accountId),
    }
    // The real route handler, dispatched directly — no listener needed.
    routes = createRoutes({
      attachmentDownload: createAttachmentDownload(jmapLive, tickets),
      authIssuer: 'https://auth.example.com/api/auth',
      publicUrl: PUBLIC,
      stalwartUrl: ADMIN_URL as string,
    })
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

  test('get_email lists the PDF as a document and the cid PNG as inline, with real names/types/sizes', async () => {
    const result = await getEmail(emailDeps, { args: { id: withAttachmentsId }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Attachments (2):')
    expect(txt).toMatch(PDF_LINE_RE)
    expect(txt).toMatch(PNG_LINE_RE)
  })

  test('search_emails lists the PDF metadata and its blobId is directly redeemable', async () => {
    const result = await searchEmails(searchDeps, { args: { limit: 10, query: 'Invoice' }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain(withAttachmentsId)
    expect(txt).toContain('snippet:')
    expect(txt).toMatch(PDF_LINE_RE)
    expect(txt).not.toMatch(PNG_LINE_RE)

    const blobId = txt.match(PDF_LINE_RE)?.[1]
    expect(blobId).toBeDefined()
    const download = await downloadAttachment(dlDeps, {
      args: { blobId: blobId as string, emailId: withAttachmentsId },
      token: TOKEN,
    })
    expect(download.isError).toBeUndefined()
    expect(download.content[0]?.text ?? '').toContain('invoice.pdf (application/pdf, 602 B)')
  })

  test('multi-term search ranks the message matching more terms first, with matched counts', async () => {
    // "Invoice June text": the invoice message matches "Invoice"+"June" (2/3),
    // the plain message ("Just text.") matches only "text" (1/3). Both were
    // imported with the same receivedAt, so only ranking makes the order
    // deterministic.
    const result = await searchEmails(searchDeps, { args: { limit: 10, query: 'Invoice June text' }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain(withAttachmentsId)
    expect(txt).toContain(plainId)
    expect(txt.indexOf(withAttachmentsId)).toBeLessThan(txt.indexOf(plainId))
    expect(txt).toContain('matched: 2/3 terms')
    expect(txt).toContain('matched: 1/3 terms')
  })

  test('download_attachment mints a URL whose GET streams back the exact fixture bytes', async () => {
    const detail = await getEmail(emailDeps, { args: { id: withAttachmentsId }, token: TOKEN })
    const blobId = (detail.content[0]?.text ?? '').match(PDF_LINE_RE)?.[1]
    expect(blobId).toBeDefined()

    const result = await downloadAttachment(dlDeps, {
      args: { blobId: blobId as string, emailId: withAttachmentsId },
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('invoice.pdf (application/pdf, 602 B)')
    const url = txt.match(DOWNLOAD_URL_RE)?.[1]
    expect(url).toBeDefined()

    const res = await routes.fetch(new Request(url as string))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('filename="invoice.pdf"')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(pdfBytes)
  })

  test('a tampered token is a plain 404', async () => {
    const result = await downloadAttachment(dlDeps, {
      args: {
        blobId: (
          (await getEmail(emailDeps, { args: { id: withAttachmentsId }, token: TOKEN })).content[0]?.text ?? ''
        ).match(PDF_LINE_RE)?.[1] as string,
        emailId: withAttachmentsId,
      },
      token: TOKEN,
    })
    const url = (result.content[0]?.text ?? '').match(DOWNLOAD_URL_RE)?.[1] as string
    // Flip the last token character.
    const flipped = url.slice(0, -1) + (url.endsWith('A') ? 'B' : 'A')
    const res = await routes.fetch(new Request(flipped))
    expect(res.status).toBe(404)
  })

  test("requesting message A's blobId under message B's id is a tool error", async () => {
    const blobId = (
      (await getEmail(emailDeps, { args: { id: withAttachmentsId }, token: TOKEN })).content[0]?.text ?? ''
    ).match(PDF_LINE_RE)?.[1] as string
    const result = await downloadAttachment(dlDeps, { args: { blobId, emailId: plainId }, token: TOKEN })
    expect(result.isError).toBe(true)
  })

  test('context hygiene: tool results stay small and never carry the bytes', async () => {
    const detail = await getEmail(emailDeps, { args: { id: withAttachmentsId }, token: TOKEN })
    const detailTxt = detail.content[0]?.text ?? ''
    const blobId = detailTxt.match(PDF_LINE_RE)?.[1] as string
    const download = await downloadAttachment(dlDeps, { args: { blobId, emailId: withAttachmentsId }, token: TOKEN })
    const downloadTxt = download.content[0]?.text ?? ''

    for (const txt of [detailTxt, downloadTxt]) {
      expect(txt.length).toBeLessThan(2048)
      expect(txt).not.toMatch(BASE64_RUN_RE)
    }
  })
})
