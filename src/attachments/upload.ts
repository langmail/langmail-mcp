// Redeem an attachment upload ticket: read the PUT body (capped), store it as
// a blob in the ticket's account with the ticket's stored bearer, and answer
// with the blobId create_draft / update_draft take. Routing lives in
// handler.ts; this file owns the response shaping.
//
// The answer is JSON on purpose: the agent reads it from curl's stdout, and
// the `next` line tells it what to do with the blobId without going back to
// the tool description.
//
// Logging carries only status/size — never tokens or filenames (REVIEW.md: no
// PII in logs).

import { blobUpload, type JmapLive } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { MAX_ATTACHMENT_BYTES } from '../drafts/attachments.ts'
import { describeError } from '../observability/errors.ts'
import { type UploadTicketStore } from './upload-tickets.ts'

export type AttachmentUpload = (token: string, req: Request) => Promise<Response>

// How long Stalwart keeps a blob no message references yet: its JMAP
// `uploadTtl`, which we leave at the 0.16 default of one hour
// (crates/registry/src/schema/structs_impl.rs, `Duration::from_millis(3600000)`).
// Past that the blobId names nothing and create_draft is refused, so the
// response states the window.
export const UNREFERENCED_BLOB_TTL_MINUTES = 60

const MAX_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024)

// The `attachments` entry create_draft needs for an uploaded file. `mimeType`
// rides along because create_draft derives a part's type from the entry, not
// from the blob: without it, a `scan` uploaded as image/tiff would arrive as
// application/octet-stream.
export const attachEntry = (blobId: string, filename: string, mimeType: string): string =>
  JSON.stringify({ blobId, filename, mimeType })

const json = (body: Record<string, unknown>, status: number): Response =>
  new Response(`${JSON.stringify(body)}\n`, {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status,
  })

const USED_NOW = 'This URL is now used; call upload_attachments for a new one.'

const notFound = (): Response =>
  json(
    {
      error: 'not_found',
      message: 'This upload URL is unknown, expired, or already used. Call upload_attachments for a new one.',
    },
    404
  )

// `spent` says whether the URL still works: a declared oversize body is refused
// before the ticket is taken, one found oversize while reading is not.
const tooLarge = (spent: boolean): Response =>
  json(
    {
      error: 'too_large',
      message:
        `The file is over the ${MAX_MB} MB an attachment can be. Nothing was stored. ` +
        (spent ? USED_NOW : 'Retry this URL with a smaller file.'),
    },
    413
  )

// The body, or null once it runs past `limit` — read chunk by chunk, so an
// oversized upload that lied about (or omitted) its Content-Length is cut off
// at the cap rather than buffered whole.
const readCapped = async (body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> => {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > limit) {
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export const createAttachmentUpload = (live: JmapLive, tickets: UploadTicketStore): AttachmentUpload => {
  return async (token, req) => {
    // Unknown, used, and expired tokens are indistinguishable on purpose.
    if (!tickets.lookup(token)) {
      return notFound()
    }
    // Refused before the ticket is spent, so a caller who picked the wrong
    // file can retry the same URL with the right one.
    if (Number(req.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) {
      return tooLarge(false)
    }
    const ticket = tickets.take(token)
    if (!ticket) {
      return notFound()
    }
    let bytes: Uint8Array | null
    try {
      bytes = req.body ? await readCapped(req.body, MAX_ATTACHMENT_BYTES) : new Uint8Array()
    } catch (err) {
      // The client went away mid-PUT (reset, curl killed). Routine on a flaky
      // network, so a warn and a plain answer rather than the server's
      // error-level handler and an error-tracking alert.
      logger.warn({ ...describeError(err), status: 400 }, 'attachment upload body incomplete')
      return json(
        {
          error: 'incomplete',
          message: `The upload was cut off before it finished, so nothing was stored. ${USED_NOW}`,
        },
        400
      )
    }
    if (!bytes) {
      return tooLarge(true)
    }
    if (bytes.byteLength === 0) {
      return json(
        {
          error: 'empty',
          message:
            'The upload had no bytes, so nothing was stored. Send the file as the request body, e.g. ' +
            `curl -T '<file>' '<url>'. ${USED_NOW}`,
        },
        400
      )
    }

    let blobId: string
    try {
      const session = await live.getSession(ticket.authorization)
      blobId = await blobUpload({
        accountId: ticket.accountId,
        authorization: ticket.authorization,
        content: bytes,
        type: ticket.type,
        uploadUrl: session.uploadUrl,
      })
    } catch (err) {
      // E.g. the bound bearer expired, or Stalwart's upload quota is spent.
      // `status` is what we answered, as on every other line here; Stalwart's
      // own status, when it gave one, is `upstreamStatus`.
      const detail = describeError(err)
      logger.warn({ ...detail, status: 502, upstreamStatus: detail.status }, 'attachment blob upload failed')
      return json(
        {
          error: 'upstream_error',
          message:
            'The mail server did not accept the file, so nothing was stored. Call upload_attachments ' +
            'for a new URL and try again.',
        },
        502
      )
    }

    logger.info({ size: bytes.byteLength, status: 200 }, 'attachment uploaded')
    return json(
      {
        blobId,
        filename: ticket.filename,
        mimeType: ticket.type,
        next:
          `Attach it within ${UNREFERENCED_BLOB_TTL_MINUTES} minutes by passing ` +
          `${attachEntry(blobId, ticket.filename, ticket.type)} in the \`attachments\` of ` +
          'create_draft or update_draft. An upload no draft references by then is discarded.',
        size: bytes.byteLength,
      },
      200
    )
  }
}
