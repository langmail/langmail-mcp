// HTTP handler factory for the MCP resource server.
//
// Pulled out of `index.ts` so the request shape can be unit-tested
// without spinning up Bun.serve. `index.ts` does config + transport
// wiring; this file owns routing.

import { TokenCache } from "./auth/tokenCache.ts";
import {
  createAuthMiddleware,
  type AuthContext,
  type AuthMiddleware,
} from "./auth/middleware.ts";
import { createDcrHandler, type DcrHandler } from "./auth/dcr.ts";

export interface HandlerConfig {
  publicUrl: string;
  stalwartUrl: string;
  cache?: TokenCache;
  // Authenticated MCP handler. Phase 1 leaves this stubbed to 501;
  // phase 2 wires StreamableHTTPServerTransport in here.
  mcpHandler?: (req: Request, ctx: AuthContext) => Promise<Response>;
  // Authorization header value used by the DCR proxy when calling
  // Stalwart's /auth/register (e.g. "Basic <base64>"). Unset → the
  // proxy responds 503; discovery still advertises the endpoint so
  // misconfiguration shows up loudly rather than masquerading.
  dcrUpstreamAuth?: string;
  // Test seam.
  dcrHandler?: DcrHandler;
}

export interface Routes {
  fetch: (req: Request) => Promise<Response>;
  authenticate: AuthMiddleware;
}

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

export function createRoutes(cfg: HandlerConfig): Routes {
  const cache = cfg.cache ?? new TokenCache();
  const authenticate = createAuthMiddleware({
    stalwartBase: cfg.stalwartUrl,
    publicUrl: cfg.publicUrl,
    cache,
  });
  const dcrHandler =
    cfg.dcrHandler ??
    createDcrHandler({
      stalwartBase: cfg.stalwartUrl,
      upstreamAuth: cfg.dcrUpstreamAuth,
    });

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // We advertise ourselves as the AS (issuer = our public URL) so the
      // MCP SDK fetches THIS document instead of Stalwart's own (which
      // would point it at Stalwart's admin-gated /auth/register and
      // trigger a Problem-Details 401 the SDK can't parse). PRM below
      // points clients here; per RFC 8414 §3.3 the SDK validates that
      // `issuer` matches the URL it discovered the metadata from.
      //
      // Authorize/token/etc. still point at Stalwart directly — the
      // RFC doesn't require endpoints to live on the issuer's host.
      // Only /auth/register has to be us (the DCR proxy). Access
      // tokens stay opaque per RFC 6749, so the issuer mismatch
      // doesn't surface anywhere client-side.
      //
      // NB: Stalwart 0.16's authorize endpoint is /login, not the
      // OIDC-conventional /authorize.
      return json({
        issuer: cfg.publicUrl,
        authorization_endpoint: `${cfg.stalwartUrl}/login`,
        token_endpoint: `${cfg.stalwartUrl}/auth/token`,
        registration_endpoint: `${cfg.publicUrl}/auth/register`,
        userinfo_endpoint: `${cfg.stalwartUrl}/auth/userinfo`,
        introspection_endpoint: `${cfg.stalwartUrl}/auth/introspect`,
        revocation_endpoint: `${cfg.stalwartUrl}/auth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["openid", "offline_access"],
        resource: cfg.publicUrl,
      });
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      // RFC 9728 — lets MCP clients discover the AS from this RS's URL
      // alone, which is what the `WWW-Authenticate: resource_metadata=...`
      // header points them at on a 401.
      return json({
        resource: cfg.publicUrl,
        // Point at ourselves, not Stalwart, so the MCP SDK discovers
        // our AS metadata (with the DCR proxy registration_endpoint)
        // instead of Stalwart's (which advertises an admin-gated
        // /auth/register the SDK can't reach).
        authorization_servers: [cfg.publicUrl],
        bearer_methods_supported: ["header"],
      });
    }

    if (url.pathname === "/auth/register") {
      return dcrHandler(req);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const result = await authenticate(req);
      if (result instanceof Response) return result;
      if (cfg.mcpHandler) return cfg.mcpHandler(req, result);
      return json(
        {
          error: "not_implemented",
          detail: "MCP transport lands in phase 2",
          principal: result.principal,
        },
        { status: 501 },
      );
    }

    return new Response("not found\n", { status: 404 });
  };

  return { fetch: fetchHandler, authenticate };
}
