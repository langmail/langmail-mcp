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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthContext } from "../auth/middleware.ts";
import {
  makeLiveDeps,
  registerSearchEmails,
} from "../tools/searchEmails.ts";
import { SessionCache } from "../jmap/session.ts";

export interface McpHandlerConfig {
  stalwartUrl: string;
}

export function createMcpHandler(
  cfg: McpHandlerConfig,
): (req: Request, ctx: AuthContext) => Promise<Response> {
  // Shared across requests: JMAP session lookups dedupe across all
  // bearer tokens we've seen.
  const sessionCache = new SessionCache();
  const deps = makeLiveDeps({
    stalwartUrl: cfg.stalwartUrl,
    sessionCache,
  });

  return async (req, ctx) => {
    const server = new McpServer({
      name: "langmail-mcp",
      version: "0.1.0",
    });
    registerSearchEmails(server, deps, () => ctx.token);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);

    return transport.handleRequest(req, {
      authInfo: {
        token: ctx.token,
        clientId: "langmail-mcp",
        scopes: [],
        extra: { principal: ctx.principal },
      },
    });
  };
}
