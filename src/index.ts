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

const PUBLIC_URL = (
  process.env.MCP_PUBLIC_URL ?? `http://${HOST}:${PORT}`
).replace(/\/+$/u, "");
const STALWART_URL = (
  process.env.STALWART_PUBLIC_URL ?? "https://mail.langmail.me"
).replace(/\/+$/u, "");

// Credentials for the DCR proxy. Two accepted shapes:
//   STALWART_DCR_AUTH  — full header value (e.g. "Basic <base64>")
//   STALWART_DCR_USER + STALWART_DCR_PASSWORD — convenience pair
// The systemd unit picks up the env file from /run/secrets/mcp.env;
// see infra/scripts/setup-mcp-dcr-secret.sh for how the value is
// generated and shipped.
let dcrUpstreamAuth = process.env.STALWART_DCR_AUTH;
if (
  !dcrUpstreamAuth &&
  process.env.STALWART_DCR_USER &&
  process.env.STALWART_DCR_PASSWORD
) {
  const raw = `${process.env.STALWART_DCR_USER}:${process.env.STALWART_DCR_PASSWORD}`;
  dcrUpstreamAuth = `Basic ${Buffer.from(raw).toString("base64")}`;
}

const routes = createRoutes({
  dcrUpstreamAuth,
  mcpHandler: createMcpHandler({ stalwartUrl: STALWART_URL }),
  publicUrl: PUBLIC_URL,
  stalwartUrl: STALWART_URL,
});

const server = Bun.serve({
  fetch: routes.fetch,
  hostname: HOST,
  port: PORT,
});

console.log(`mcp listening on http://${server.hostname}:${server.port}`);
console.log(`  public URL: ${PUBLIC_URL}`);
console.log(`  upstream AS: ${STALWART_URL}`);
console.log(
  `  DCR proxy:   ${dcrUpstreamAuth ? "enabled" : "DISABLED (no creds)"}`
);
