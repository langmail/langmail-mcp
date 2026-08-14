// MCP resource server entrypoint.
//
// Routing + auth live in `handler.ts`; this file owns process-level
// concerns: reading env, spinning up Bun.serve, and (phase 2) handing
// the authenticated request stream to StreamableHTTPServerTransport.
//
// See spec/02-mcp.md for the design; spec/03 §MCP RS auth model for
// why we trust /auth/userinfo rather than verifying JWTs locally.

import { logger } from '@langmail/logger'
import { initErrorTracking } from '@langmail/logger/error-tracking'

initErrorTracking('mcp')

import { makeJmapLive } from '@langmail/jmap'

import { createAttachmentDownload } from './attachments/download.ts'
import { createTicketStore } from './attachments/tickets.ts'
import { createImageProxy, createImageProxyStore } from './email-render/image-proxy.ts'
import { createRoutes } from './handler.ts'
import { createMcpHandler } from './mcp/handler.ts'
import { logObservabilityConfig } from './observability/config.ts'
import { describeError } from './observability/errors.ts'

const TRAILING_SLASHES_RE = /\/+$/u

const PORT = Number(process.env.MCP_PORT ?? 8080)
const HOST = process.env.MCP_HOST ?? '127.0.0.1'

const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(TRAILING_SLASHES_RE, '')
const STALWART_URL = (process.env.STALWART_PUBLIC_URL ?? 'https://mail.langmail.me').replace(TRAILING_SLASHES_RE, '')

// Better Auth is the OpenID Provider for the MCP server (as for app + webmail):
// clients authenticate against it, and we validate every bearer at its userinfo.
// The issuer mirrors services/auth's `${baseURL}/api/auth` derivation.
const AUTH_URL = (process.env.AUTH_PUBLIC_URL ?? 'https://auth.langmail.me').replace(TRAILING_SLASHES_RE, '')
const AUTH_ISSUER = `${AUTH_URL}/api/auth`

// One JMAP session cache + one ticket store shared between the MCP tool
// surface (download_attachment mints) and the plain-HTTP download route
// (GET /attachments/:token redeems). The image-proxy store follows the same
// mint/redeem split for preview_email's remote images.
const jmapLive = makeJmapLive(STALWART_URL)
const tickets = createTicketStore()
const imageTokens = createImageProxyStore()

const routes = createRoutes({
  attachmentDownload: createAttachmentDownload(jmapLive, tickets),
  authIssuer: AUTH_ISSUER,
  imageProxy: createImageProxy(imageTokens),
  mcpHandler: createMcpHandler({
    imageTokens,
    live: jmapLive,
    publicUrl: PUBLIC_URL,
    stalwartUrl: STALWART_URL,
    tickets,
  }),
  publicUrl: PUBLIC_URL,
  stalwartUrl: STALWART_URL,
})

const server = Bun.serve({
  // Without this, an exception escaping the handler becomes Bun's default 500
  // and no system records it (L-2 in the 2026-06-18 security review). With it,
  // the failure reaches Better Stack error tracking through pinoIntegration's
  // capture of `error`-level lines — no further wiring.
  error: (error: Error): Response => {
    logger.error(describeError(error), 'mcp unhandled request error')
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      headers: { 'content-type': 'application/json' },
      status: 500,
    })
  },
  fetch: routes.fetch,
  hostname: HOST,
  port: PORT,
})

logObservabilityConfig()

logger.info(
  {
    address: `http://${server.hostname}:${server.port}`,
    publicUrl: PUBLIC_URL,
    authIssuer: AUTH_ISSUER,
    jmapUpstream: STALWART_URL,
  },
  'mcp listening'
)
