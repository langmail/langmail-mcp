// MCP resource server entrypoint.
//
// Routing + auth live in `handler.ts`; this file owns process-level
// concerns: reading env, spinning up Bun.serve, and (phase 2) handing
// the authenticated request stream to StreamableHTTPServerTransport.
//
// See spec/02-mcp.md for the design; spec/03 §MCP RS auth model for
// why we trust /auth/userinfo rather than verifying JWTs locally.

import { createRoutes } from "./handler.ts";
import { createMcpHandler } from "./mcp/handler.ts";

const PORT = Number(process.env.MCP_PORT ?? 8080);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";

const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? `http://${HOST}:${PORT}`)
  .replace(/\/+$/, "");
const STALWART_URL = (process.env.STALWART_PUBLIC_URL ?? "https://mail.langmail.me")
  .replace(/\/+$/, "");

const routes = createRoutes({
  publicUrl: PUBLIC_URL,
  stalwartUrl: STALWART_URL,
  mcpHandler: createMcpHandler({ stalwartUrl: STALWART_URL }),
});

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: routes.fetch,
});

console.log(`mcp listening on http://${server.hostname}:${server.port}`);
console.log(`  public URL: ${PUBLIC_URL}`);
console.log(`  upstream AS: ${STALWART_URL}`);
