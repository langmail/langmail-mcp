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
import { createRoutes } from './handler.ts'
import { createMcpHandler } from './mcp/handler.ts'

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
// (GET /attachments/:token redeems).
const jmapLive = makeJmapLive(STALWART_URL)
const tickets = createTicketStore()

const routes = createRoutes({
  attachmentDownload: createAttachmentDownload(jmapLive, tickets),
  authIssuer: AUTH_ISSUER,
  mcpHandler: createMcpHandler({ live: jmapLive, publicUrl: PUBLIC_URL, stalwartUrl: STALWART_URL, tickets }),
  publicUrl: PUBLIC_URL,
  stalwartUrl: STALWART_URL,
})

const server = Bun.serve({
  fetch: routes.fetch,
  hostname: HOST,
  port: PORT,
})

logger.info(
  {
    address: `http://${server.hostname}:${server.port}`,
    publicUrl: PUBLIC_URL,
    authIssuer: AUTH_ISSUER,
    jmapUpstream: STALWART_URL,
  },
  'mcp listening'
)
