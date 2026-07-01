// HTTP handler factory for the MCP resource server.
//
// Pulled out of `index.ts` so the request shape can be unit-tested
// without spinning up Bun.serve. `index.ts` does config + transport
// wiring; this file owns routing.

import { type AuthContext, type AuthMiddleware, createAuthMiddleware } from './auth/middleware.ts'
import { TokenCache } from './auth/token-cache.ts'
import {
  authReachable,
  createReadiness,
  type ReadyResult,
  readyzResponse,
  stalwartReachable,
} from './health/readiness.ts'

export interface HandlerConfig {
  // Better Auth OIDC issuer, e.g. https://auth.langmail.me/api/auth. The MCP
  // server advertises Better Auth's oauth2 endpoints (derived from this) as
  // its authorization server and validates every bearer at its userinfo.
  authIssuer: string
  cache?: TokenCache
  // Authenticated MCP handler. Phase 1 leaves this stubbed to 501;
  // phase 2 wires StreamableHTTPServerTransport in here.
  mcpHandler?: (req: Request, ctx: AuthContext) => Promise<Response>
  publicUrl: string
  // Readiness checker. Defaults to probing Better Auth (token validation) and
  // Stalwart (JMAP/DAV egress); injectable so tests can supply a fake.
  readiness?: () => Promise<ReadyResult>
  // Stalwart base URL — where the validated bearer is forwarded for JMAP/DAV.
  stalwartUrl: string
}

export interface Routes {
  authenticate: AuthMiddleware
  fetch: (req: Request) => Promise<Response>
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      ...init.headers,
    },
  })

export const createRoutes = (cfg: HandlerConfig): Routes => {
  const cache = cfg.cache ?? new TokenCache()
  const authenticate = createAuthMiddleware({
    authIssuer: cfg.authIssuer,
    cache,
    publicUrl: cfg.publicUrl,
  })
  const readiness =
    cfg.readiness ??
    createReadiness({
      auth: authReachable(cfg.authIssuer),
      stalwart: stalwartReachable(cfg.stalwartUrl),
    })

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (url.pathname === '/healthz') {
      return new Response('ok\n', {
        headers: { 'content-type': 'text/plain' },
      })
    }

    if (url.pathname === '/readyz') {
      return readyzResponse(await readiness())
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      // We advertise ourselves as the AS (issuer = our public URL) so the
      // MCP SDK fetches THIS document at the conventional well-known path,
      // instead of trying to derive Better Auth's metadata location from its
      // `/api/auth` issuer — the RFC 8414 path-insertion forms
      // (`/.well-known/oauth-authorization-server/api/auth`) 404 on Better
      // Auth, which only serves OIDC discovery at
      // `/api/auth/.well-known/openid-configuration`. This facade sidesteps
      // that discovery fragility. The PRM below points clients here; per RFC
      // 8414 §3.3 the SDK validates `issuer` matches the metadata URL.
      //
      // Authorize/token/userinfo/register all point at Better Auth — the RFC
      // doesn't require endpoints to live on the issuer's host, and Better
      // Auth's access tokens stay opaque, so the issuer mismatch doesn't
      // surface client-side. `email` is advertised as a standard, requestable
      // scope; note the mailbox-address `email` claim that Stalwart's JMAP
      // mapping and our principal read consume is asserted by Better Auth's
      // getAdditionalUserInfoClaim regardless of whether `email` was granted.
      const oauth2 = `${cfg.authIssuer}/oauth2`
      return json({
        authorization_endpoint: `${oauth2}/authorize`,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        issuer: cfg.publicUrl,
        registration_endpoint: `${oauth2}/register`,
        resource: cfg.publicUrl,
        response_types_supported: ['code'],
        scopes_supported: ['openid', 'email', 'offline_access'],
        token_endpoint: `${oauth2}/token`,
        token_endpoint_auth_methods_supported: ['none'],
        userinfo_endpoint: `${oauth2}/userinfo`,
      })
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      // RFC 9728 — lets MCP clients discover the AS from this RS's URL
      // alone, which is what the `WWW-Authenticate: resource_metadata=...`
      // header points them at on a 401. Point at our own AS facade above
      // (not Better Auth directly) to avoid the discovery fragility noted there.
      return json({
        authorization_servers: [cfg.publicUrl],
        bearer_methods_supported: ['header'],
        resource: cfg.publicUrl,
      })
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      const result = await authenticate(req)
      if (result instanceof Response) {
        return result
      }
      if (cfg.mcpHandler) {
        return cfg.mcpHandler(req, result)
      }
      return json(
        {
          detail: 'MCP transport lands in phase 2',
          error: 'not_implemented',
          principal: result.principal,
        },
        { status: 501 }
      )
    }

    return new Response('not found\n', { status: 404 })
  }

  return { authenticate, fetch: fetchHandler }
}
