// Redeem an attachment ticket: fetch the blob from Stalwart with the
// ticket's stored bearer and stream it through. Routing lives in
// handler.ts; this file owns the response shaping.
//
// Logging deliberately carries only status/size — never tokens or
// filenames (REVIEW.md: no PII in logs).

import { blobDownload, JmapError, type JmapLive } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { type TicketStore } from './tickets.ts'

export type AttachmentDownload = (token: string) => Promise<Response>

// Keep the filename header-safe: strip quotes, backslashes, and control
// characters (Unicode category Cc) so a hostile filename can't smuggle
// extra headers or escape the quoted-string.
const sanitizeFilename = (name: string): string => {
  const cleaned = name.replaceAll(/[\p{Cc}"\\]/gu, '').trim()
  return cleaned || 'attachment'
}

const notFound = (): Response => new Response('not found\n', { status: 404 })

export const createAttachmentDownload = (live: JmapLive, tickets: TicketStore): AttachmentDownload => {
  return async (token) => {
    // Unknown and expired tokens are indistinguishable on purpose.
    const ticket = tickets.lookup(token)
    if (!ticket) {
      return notFound()
    }
    let upstream: Response
    try {
      const session = await live.getSession(ticket.authorization)
      upstream = await blobDownload({
        accountId: ticket.accountId,
        authorization: ticket.authorization,
        blobId: ticket.blobId,
        downloadUrl: session.downloadUrl,
        name: ticket.name,
        type: ticket.type,
      })
    } catch (err) {
      // E.g. the bound bearer expired before the ticket did — the agent
      // re-calls download_attachment for a fresh URL.
      const status = err instanceof JmapError ? err.status : 502
      logger.warn({ status }, 'attachment blob fetch failed')
      return new Response('upstream error\n', { status: 502 })
    }

    const headers = new Headers({
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${sanitizeFilename(ticket.name)}"`,
      'content-type': upstream.headers.get('content-type') ?? ticket.type,
    })
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) {
      headers.set('content-length', contentLength)
    }
    logger.info({ size: contentLength ? Number(contentLength) : null, status: 200 }, 'attachment downloaded')
    // Pass the upstream body through as a stream — never buffered.
    return new Response(upstream.body, { headers })
  }
}
