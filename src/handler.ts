// HTTP handler factory for the MCP resource server.
//
// Pulled out of `index.ts` so the request shape can be unit-tested
// without spinning up Bun.serve. `index.ts` does config + transport
// wiring; this file owns routing.

import { logger } from '@langmail/logger'

import { type AttachmentDownload } from './attachments/download.ts'
import { type AttachmentUpload } from './attachments/upload.ts'
import { type AuthContext, type AuthMiddleware, createAuthMiddleware } from './auth/middleware.ts'
import { MCP_SCOPES } from './auth/scopes.ts'
import { TokenCache } from './auth/token-cache.ts'
import { type CalendarFeed } from './calendar-feeds/feed.ts'
import { type ImageProxy } from './email-render/image-proxy.ts'
import {
  authReachable,
  createReadiness,
  type ReadyResult,
  readyzResponse,
  stalwartReachable,
} from './health/readiness.ts'
import { type ObservabilityStatus, observabilityConfig } from './observability/config.ts'

export interface HandlerConfig {
  // Redeems a minted attachment ticket (GET /attachments/:token). No bearer
  // required on that route — the unguessable token is the credential, same
  // model as a presigned URL. Absent → the route 404s.
  attachmentDownload?: AttachmentDownload
  // Redeems a minted upload ticket (PUT /attachments/uploads/:token) — the
  // upload_attachments direction. Same credential model; single-use.
  // Absent → the route 404s.
  attachmentUpload?: AttachmentUpload
  // Better Auth OIDC issuer, e.g. https://auth.langmail.me/api/auth. The MCP
  // server advertises Better Auth's oauth2 endpoints (derived from this) as
  // its authorization server and validates every bearer at its userinfo.
  authIssuer: string
  cache?: TokenCache
  // Serves a calendar share's feed (GET /calendar-feeds/<secret>.ics). No
  // bearer — the secret in the link is the credential. Absent → the route 404s.
  calendarFeed?: CalendarFeed
  // Redeems a minted image-proxy ticket (GET /image-proxy/:token) — the
  // email-viewer's remote images. Same credential model as attachments.
  // Absent → the route 404s.
  imageProxy?: ImageProxy
  // Authenticated MCP handler. Phase 1 leaves this stubbed to 501;
  // phase 2 wires StreamableHTTPServerTransport in here.
  mcpHandler?: (req: Request, ctx: AuthContext) => Promise<Response>
  // Reports whether log shipping / error tracking are configured; surfaced on
  // /readyz. Injectable so tests don't depend on the process environment.
  observability?: ObservabilityStatus
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

const UPLOADS_PREFIX = '/attachments/uploads/'

// Anything but a clean GET (download) or PUT (upload) of a single token
// segment is a plain 404 — indistinguishable from an unknown/expired token,
// on purpose.
const attachmentsRoute = (
  req: Request,
  pathname: string,
  download?: AttachmentDownload,
  upload?: AttachmentUpload
): Promise<Response> => {
  // Under /attachments/ so nginx's access-log-off block covers the token here
  // too. A download token is base64url and so never contains a slash, which
  // keeps the two shapes apart.
  if (pathname.startsWith(UPLOADS_PREFIX)) {
    const uploadToken = pathname.slice(UPLOADS_PREFIX.length)
    if (req.method === 'PUT' && upload && uploadToken && !uploadToken.includes('/')) {
      return upload(uploadToken, req)
    }
    return Promise.resolve(new Response('not found\n', { status: 404 }))
  }
  const token = pathname.slice('/attachments/'.length)
  if (req.method === 'GET' && download && token && !token.includes('/')) {
    return download(token)
  }
  return Promise.resolve(new Response('not found\n', { status: 404 }))
}

const imageProxyRoute = (req: Request, pathname: string, proxy?: ImageProxy): Promise<Response> => {
  const token = pathname.slice('/image-proxy/'.length)
  if (req.method === 'GET' && proxy && token && !token.includes('/')) {
    return proxy(token)
  }
  return Promise.resolve(new Response('not found\n', { status: 404 }))
}

// `/calendar-feeds/<secret>.ics`: the secret is base64url, so never holds a
// slash or a dot. Under its own prefix so nginx's access-log-off block covers
// the secret.
const CALENDAR_FEED_RE = /^\/calendar-feeds\/([^/.]+)\.ics$/u

const calendarFeedRoute = (req: Request, pathname: string, feed?: CalendarFeed): Promise<Response> => {
  const secret = CALENDAR_FEED_RE.exec(pathname)?.[1]
  if ((req.method === 'GET' || req.method === 'HEAD') && feed && secret) {
    return feed(secret)
  }
  return Promise.resolve(new Response('not found\n', { status: 404 }))
}

// One structured line per /mcp request: what it was, how it ended, how long it
// took. Method + route + status + duration carry no PII (REVIEW.md), and this
// is the record that answers "were requests arriving, and where did they stop"
// after an incident. Health and well-known routes are deliberately unlogged —
// the uptime monitor polls them every three minutes and would drown the rest.
//
// Note this only fires on *completion*: a request still hung on an upstream has
// logged nothing yet. nginx's access log in journald is the arrival signal (see
// infra/RUNBOOK.md).
const logRequest = async (req: Request, route: string, handle: () => Promise<Response>): Promise<Response> => {
  const startedAt = performance.now()
  const res = await handle()
  logger.info(
    { durationMs: Math.round(performance.now() - startedAt), method: req.method, route, status: res.status },
    'mcp request'
  )
  return res
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
  const observability = cfg.observability ?? observabilityConfig

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (url.pathname === '/healthz') {
      return new Response('ok\n', {
        headers: { 'content-type': 'text/plain' },
      })
    }

    if (url.pathname === '/readyz') {
      return readyzResponse(await readiness(), { observability: observability() })
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
        scopes_supported: MCP_SCOPES,
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
        scopes_supported: MCP_SCOPES,
      })
    }

    if (url.pathname.startsWith('/attachments/')) {
      return attachmentsRoute(req, url.pathname, cfg.attachmentDownload, cfg.attachmentUpload)
    }

    if (url.pathname.startsWith('/calendar-feeds/')) {
      // Route label only: the pathname carries the secret.
      return logRequest(req, '/calendar-feeds', () => calendarFeedRoute(req, url.pathname, cfg.calendarFeed))
    }

    if (url.pathname.startsWith('/image-proxy/')) {
      return imageProxyRoute(req, url.pathname, cfg.imageProxy)
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // Route label is the branch, not the pathname: /mcp/<anything> is the
      // same handler, and a raw pathname would be unbounded cardinality.
      return logRequest(req, '/mcp', async () => {
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
      })
    }

    return new Response('not found\n', { status: 404 })
  }

  return { authenticate, fetch: fetchHandler }
}
