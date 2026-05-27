// Per-request MCP handler.
//
// Stateless mode: each authenticated request to /mcp creates a fresh
// McpServer + WebStandardStreamableHTTPServerTransport pair, registers
// the tool surface, and hands the Request to the transport. The
// per-request cost is modest (no DB connections to open; the JMAP
// session lookup is cached across requests via `makeLiveDeps`), and
// avoiding shared session state simplifies reasoning about token
// revocation — a 401 from /auth/userinfo is the only thing that gates
// access, and it runs before we get here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import type { AuthContext } from '../auth/middleware.ts'
import { SessionCache } from '../jmap/session-cache.ts'
import { makeLiveDeps, registerSearchEmails } from '../tools/search-emails.ts'

export interface McpHandlerConfig {
  stalwartUrl: string
}

export const createMcpHandler = (cfg: McpHandlerConfig): ((req: Request, ctx: AuthContext) => Promise<Response>) => {
  // Shared across requests: JMAP session lookups dedupe across all
  // bearer tokens we've seen.
  const sessionCache = new SessionCache()
  const deps = makeLiveDeps({
    sessionCache,
    stalwartUrl: cfg.stalwartUrl,
  })

  return async (req, ctx) => {
    const server = new McpServer({
      name: 'langmail-mcp',
      version: '0.1.0',
    })
    registerSearchEmails(server, deps, () => ctx.token)

    // Stateless mode (sessionIdGenerator omitted). Each request stands
    // alone — initialize, tool call, and shutdown happen within the
    // same HTTP exchange. Avoids needing a per-session transport map.
    const transport = new WebStandardStreamableHTTPServerTransport()
    await server.connect(transport)

    return transport.handleRequest(req, {
      authInfo: {
        clientId: 'langmail-mcp',
        extra: { principal: ctx.principal },
        scopes: [],
        token: ctx.token,
      },
    })
  }
}
