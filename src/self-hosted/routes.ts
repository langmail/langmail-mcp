// HTTP routes of the self-hosted server.
//
// What the hosted router (handler.ts) has and this one leaves out: OAuth
// discovery (/.well-known/oauth-*), Better Auth bearer validation, the
// readiness probe of Better Auth, and the calendar share feeds. /mcp takes one
// static bearer the operator sets (MCP_AUTH_TOKEN). The ticket routes are the
// same as hosted: download_attachment, upload_attachments and preview_email
// mint links under this server's URL, and the unguessable token in the link is
// the credential. Over stdio only the ticket routes are served.

import { timingSafeEqual } from 'node:crypto'

import { type AttachmentDownload } from '../attachments/download.ts'
import { type AttachmentUpload } from '../attachments/upload.ts'
import { type ImageProxy } from '../email-render/image-proxy.ts'
import { attachmentsRoute, imageProxyRoute } from '../handler.ts'
import { logger } from '../logger/index.ts'

export interface SelfHostedRoutesConfig {
  attachmentDownload: AttachmentDownload
  attachmentUpload: AttachmentUpload
  imageProxy: ImageProxy
  // The MCP endpoint and the bearer it requires; absent over stdio, where
  // /mcp answers 404.
  mcp?: { authToken: string; handle: (req: Request) => Promise<Response> }
}

const BEARER_RE = /^Bearer\s+(.+)$/iu

// Constant-time, so response timing does not reveal how much of a guess was
// right.
const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

// No resource_metadata: there is no OAuth to discover, the client is
// configured with the token.
const unauthorized = (): Response =>
  new Response(null, { headers: { 'www-authenticate': 'Bearer realm="mcp"' }, status: 401 })

const notFound = (): Response => new Response('not found\n', { status: 404 })

export const createSelfHostedRoutes = (cfg: SelfHostedRoutesConfig): ((req: Request) => Promise<Response>) => {
  const handleMcp = (req: Request): Promise<Response> => {
    if (!cfg.mcp) {
      return Promise.resolve(notFound())
    }
    const token = BEARER_RE.exec(req.headers.get('authorization') ?? '')?.[1]?.trim()
    if (!(token && sameSecret(token, cfg.mcp.authToken))) {
      return Promise.resolve(unauthorized())
    }
    return cfg.mcp.handle(req)
  }

  return async (req) => {
    const { pathname } = new URL(req.url)
    if (pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } })
    }
    if (pathname.startsWith('/attachments/')) {
      return attachmentsRoute(req, pathname, cfg.attachmentDownload, cfg.attachmentUpload)
    }
    if (pathname.startsWith('/image-proxy/')) {
      return imageProxyRoute(req, pathname, cfg.imageProxy)
    }
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      const startedAt = performance.now()
      const res = await handleMcp(req)
      logger.info(
        {
          durationMs: Math.round(performance.now() - startedAt),
          method: req.method,
          route: '/mcp',
          status: res.status,
        },
        'mcp request'
      )
      return res
    }
    return notFound()
  }
}
