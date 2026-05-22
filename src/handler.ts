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

export interface HandlerConfig {
  publicUrl: string;
  stalwartUrl: string;
  cache?: TokenCache;
  // Authenticated MCP handler. Phase 1 leaves this stubbed to 501;
  // phase 2 wires StreamableHTTPServerTransport in here.
  mcpHandler?: (req: Request, ctx: AuthContext) => Promise<Response>;
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

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // NB: Stalwart 0.16's authorize endpoint is /login, not the
      // OIDC-conventional /authorize. Mirror upstream verbatim.
      return json({
        issuer: cfg.stalwartUrl,
        authorization_endpoint: `${cfg.stalwartUrl}/login`,
        token_endpoint: `${cfg.stalwartUrl}/auth/token`,
        registration_endpoint: `${cfg.stalwartUrl}/auth/register`,
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
        authorization_servers: [cfg.stalwartUrl],
        bearer_methods_supported: ["header"],
      });
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
