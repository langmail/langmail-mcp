// Minimal MCP server scaffold (phase 3 of spec/03-monorepo-and-app-vm.md).
//
// Exposes zero tools. Two HTTP routes today:
//
//   GET /.well-known/oauth-authorization-server
//     Mirrors Stalwart's AS metadata so MCP clients can discover the
//     issuer + endpoints from THIS host's URL (the MCP resource server)
//     rather than having to know about mail.<domain> out of band.
//
//   * /mcp
//     Reserved for the MCP HTTP transport. Stubbed to 501 until
//     spec/02-mcp.md (phase 4) wires up StreamableHTTPServerTransport
//     and the first tool.
//
// Auth is intentionally absent here — phase 4 is where /auth/userinfo
// resolution against Stalwart lands. See spec/03's "MCP RS auth model"
// section for the model this server will implement.

const PORT = Number(process.env.MCP_PORT ?? 8080);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";

// Public URL this RS is reachable at (e.g. https://mcp.langmail.me).
// Used as the `resource` identifier in OAuth metadata. Must be set in
// prod via systemd EnvironmentFile; falls back to localhost for `bun dev`.
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? `http://${HOST}:${PORT}`)
  .replace(/\/+$/, "");

// Stalwart base (issuer). Same convention.
const STALWART_URL = (process.env.STALWART_PUBLIC_URL ?? "https://mail.langmail.me")
  .replace(/\/+$/, "");

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // Shape per RFC 8414. Pointers go to Stalwart (the AS); `resource`
      // names THIS server (the RS). Kept narrow on purpose — clients
      // that need more should hit Stalwart's metadata directly.
      return json({
        issuer: STALWART_URL,
        authorization_endpoint: `${STALWART_URL}/authorize`,
        token_endpoint: `${STALWART_URL}/auth/token`,
        registration_endpoint: `${STALWART_URL}/auth/register`,
        userinfo_endpoint: `${STALWART_URL}/auth/userinfo`,
        introspection_endpoint: `${STALWART_URL}/auth/introspect`,
        revocation_endpoint: `${STALWART_URL}/auth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["openid", "offline_access"],
        resource: PUBLIC_URL,
      });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok\n", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return json(
        { error: "not_implemented", detail: "MCP transport lands in phase 4" },
        { status: 501 },
      );
    }

    return new Response("not found\n", { status: 404 });
  },
});

console.log(`mcp listening on http://${server.hostname}:${server.port}`);
console.log(`  public URL: ${PUBLIC_URL}`);
console.log(`  upstream AS: ${STALWART_URL}`);
