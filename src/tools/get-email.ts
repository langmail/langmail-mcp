// get_email tool — fetch a single message's full detail (recipients plus a
// readable body) by id. search_emails deliberately omits bodies; the agent
// opens a specific hit with this tool.
//
// The body comes from the langmail cleaning pipeline: the raw RFC 5322
// message blob is downloaded from Stalwart and preprocessed into readable
// text/markdown, so HTML-only senders (inline-CSS invoice tables and the
// like) yield the same clean shape as plain-text senders. The JMAP
// textBody values are still fetched as the fallback when the raw path
// fails.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { preprocessWithOptions } from 'langmail'
import { z } from 'zod'

import {
  bearerAuthorization,
  blobDownload,
  type EmailBodyPart,
  type EmailDetailRecord,
  type EmailGetDetailParams,
  emailGetDetail,
  JmapError,
  type JmapLive,
} from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { emailTags, formatAddressList, formatSize } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// Cap the body we pull back so a huge newsletter can't blow the token budget;
// Stalwart truncates the value at this byte count.
const MAX_BODY_VALUE_BYTES = 100_000

// Raw messages above this size skip the download-and-clean path (attachments
// are base64 inside the raw blob, so a big attachment would mean buffering
// megabytes just to render the body) and fall back to the JMAP text body.
const MAX_RAW_MESSAGE_BYTES = 10_000_000

// Cap the cleaned body so a pathological message can't blow the token
// budget — mirrors MAX_BODY_VALUE_BYTES on the fallback path.
const MAX_CLEAN_BODY_CHARS = 100_000

const getEmailShape = {
  id: z.string().min(1).describe('The message id, as returned by search_emails or get_thread.'),
}

export const getEmailInput = z.object(getEmailShape)

export type GetEmailArgs = z.infer<typeof getEmailInput>

export interface RawMessageParams {
  accountId: string
  authorization: string
  blobId: string
}

export interface GetEmailDeps {
  downloadRawMessage: (p: RawMessageParams) => Promise<Uint8Array>
  emailGetDetail: (p: EmailGetDetailParams) => Promise<EmailDetailRecord[]>
  resolveAccountId: (authorization: string) => Promise<string>
}

export interface GetEmailContext {
  args: GetEmailArgs
  token: string
}

// Concatenate the text/plain body parts, resolving each part's fetched value.
// HTML-only messages fall back to Stalwart's server-side textBody resolution.
const bodyText = (e: EmailDetailRecord): string => {
  const values = e.bodyValues ?? {}
  return (e.textBody ?? [])
    .map((part) => (part.partId ? (values[part.partId]?.value ?? '') : ''))
    .filter((v) => v.length > 0)
    .join('\n')
    .trim()
}

// JmapError messages are status-only; anything else is reduced to its name
// so a fetch-level error can't leak the download URL — it embeds the
// accountId (REVIEW.md: no user IDs in logs).
const errorDetail = (err: unknown): string => {
  if (err instanceof JmapError) {
    return err.message
  }
  return err instanceof Error ? err.name : 'unknown'
}

// Primary body path: download the raw message and run it through langmail's
// cleaning pipeline (HTML → readable markdown, consistent across senders).
// Quotes and signatures are kept — the agent opened this specific message,
// so nothing may be silently dropped. Returns null when the raw path is
// unavailable (no blobId, oversized, download/parse failure) so the caller
// falls back to the JMAP text body.
const cleanedBody = async (
  deps: GetEmailDeps,
  p: Omit<RawMessageParams, 'blobId'>,
  email: EmailDetailRecord
): Promise<string | null> => {
  // Unknown size counts as oversized — the guard exists to avoid buffering
  // an arbitrarily large blob, so it must not be bypassable by a missing
  // property.
  if (!email.blobId || email.size == null || email.size > MAX_RAW_MESSAGE_BYTES) {
    return null
  }
  try {
    const raw = await deps.downloadRawMessage({ ...p, blobId: email.blobId })
    const processed = preprocessWithOptions(Buffer.from(raw), {
      maxBodyLength: MAX_CLEAN_BODY_CHARS,
      stripQuotes: false,
      stripSignature: false,
    })
    return processed.body.trim() || null
  } catch (err) {
    logger.warn({ detail: errorDetail(err) }, 'raw message preprocessing failed, falling back to jmap text body')
    return null
  }
}

// A part referenced from the rendered HTML body by Content-ID (logos,
// signature images, tracking pixels) — listed but marked so the agent can
// skip it when hunting for genuine documents.
const isInlinePart = (part: EmailBodyPart): boolean => part.disposition === 'inline' && Boolean(part.cid)

const attachmentLine = (idx: number, part: EmailBodyPart): string => {
  const pieces = [
    `${part.name ?? '(unnamed)'} — ${part.type ?? 'application/octet-stream'}, ${formatSize(part.size ?? 0)}`,
  ]
  if (isInlinePart(part)) {
    pieces.push('inline')
  }
  pieces.push(`blobId: ${part.blobId ?? '(none)'}`)
  return `${idx}. ${pieces.join(' — ')}`
}

const attachmentsSection = (e: EmailDetailRecord): string => {
  const parts = e.attachments ?? []
  if (parts.length === 0) {
    return ''
  }
  const lines = parts.map((part, i) => attachmentLine(i + 1, part))
  return `\n\nAttachments (${parts.length}):\n${lines.join('\n')}`
}

export const getEmail = async (deps: GetEmailDeps, ctx: GetEmailContext): Promise<ToolResult> => {
  const { token, args } = ctx
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)
  const [email] = await deps.emailGetDetail({
    accountId,
    apiUrl: '',
    authorization,
    ids: [args.id],
    maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
  })
  if (!email) {
    return errorResult(`Email not found: ${args.id}`)
  }

  const header = [
    `Subject: ${email.subject ?? '(no subject)'}`,
    `From: ${formatAddressList(email.from) || '(unknown sender)'}`,
    `To: ${formatAddressList(email.to) || '(none)'}`,
  ]
  const cc = formatAddressList(email.cc)
  if (cc) {
    header.push(`Cc: ${cc}`)
  }
  header.push(`Date: ${email.receivedAt ?? ''}`)
  const tags = emailTags(email)
  if (tags.length > 0) {
    header.push(`Tags: ${tags.join(', ')}`)
  }
  const clean = await cleanedBody(deps, { accountId, authorization }, email)
  const body = clean ?? (bodyText(email) || '(no text body)')
  return textResult(`${header.join('\n')}\n\n${body}${attachmentsSection(email)}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive): GetEmailDeps => ({
  downloadRawMessage: async (p) => {
    const res = await blobDownload({
      accountId: p.accountId,
      authorization: p.authorization,
      blobId: p.blobId,
      downloadUrl: (await live.getSession(p.authorization)).downloadUrl,
      name: 'message.eml',
      type: 'message/rfc822',
    })
    return new Uint8Array(await res.arrayBuffer())
  },
  emailGetDetail: async (p) => emailGetDetail({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  resolveAccountId: live.resolveAccountId,
})

// --- MCP registration ----------------------------------------------------

export const registerGetEmail = (server: McpServer, deps: GetEmailDeps, getToken: () => string): void => {
  server.registerTool(
    'get_email',
    {
      description:
        "Fetch a single message's recipients and body by id. The body is " +
        'rendered as readable text/markdown regardless of how the sender ' +
        'formatted it (HTML newsletters and invoices come back as clean ' +
        'markdown, not raw HTML). Use the ' +
        'id returned by search_emails or get_thread. Attachments are listed ' +
        'after the body with filename, media type, size, and blobId; parts ' +
        'marked "inline" are images referenced by the HTML body (logos, ' +
        'signatures) rather than genuine documents. Fetch attachment bytes ' +
        'with download_attachment — they are never returned here.',
      inputSchema: getEmailShape,
      title: 'Get email',
    },
    (args) => {
      const parsed = getEmailInput.parse(args)
      return getEmail(deps, { args: parsed, token: getToken() })
    }
  )
}
