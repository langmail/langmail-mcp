// Dynamic Client Registration proxy (RFC 7591).
//
// Stalwart 0.16's /auth/register requires admin auth — by design, per
// spec/02 §Phase 1. That conflicts with MCP clients (Claude Code,
// Claude Desktop) which expect to do unauthenticated DCR against the
// endpoint advertised in /.well-known/oauth-authorization-server.
//
// This handler accepts an unauthenticated RFC 7591 registration
// request, validates redirect_uris, and proxies to Stalwart with the
// admin credentials baked into the MCP service's environment. Any
// non-2xx from Stalwart is rewritten into RFC 6749 error JSON
// (`{"error":"...","error_description":"..."}`) so MCP clients can
// parse it — Stalwart returns RFC 7807 Problem Details, which the
// MCP TypeScript SDK chokes on with a Zod parse error.

export interface DcrProxyOptions {
  stalwartBase: string
  // Full value for the Authorization header sent to Stalwart, e.g.
  // "Basic <base64(admin:password)>". Omit to disable the proxy
  // (handler returns 503 with a clear error).
  upstreamAuth?: string
}

export type DcrHandler = (req: Request) => Promise<Response>

const err = (status: number, error: string, description: string): Response =>
  Response.json(
    { error, error_description: description },
    {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      },
      status,
    }
  )

// RFC 7591 §5: native + web clients may use loopback redirect URIs
// over http; everything else MUST be https. Permissive enough for
// MCP CLI clients (loopback) and headless server-side callbacks.
const isAllowedRedirectUri = (raw: unknown): raw is string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return false
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol === 'https:') {
    return true
  }
  if (u.protocol === 'http:') {
    const h = u.hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  }
  // Custom schemes (e.g. "myapp://cb") are valid RFC 7591 but we
  // don't expect them; reject defensively.
  return false
}

export const createDcrHandler =
  (opts: DcrProxyOptions): DcrHandler =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear validation pipeline
  async (req) => {
    if (req.method !== 'POST') {
      return err(405, 'invalid_request', 'POST required')
    }

    if (!opts.upstreamAuth) {
      return err(503, 'temporarily_unavailable', 'DCR proxy not configured on this server')
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return err(400, 'invalid_client_metadata', 'body is not valid JSON')
    }

    const uris = body.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0) {
      return err(400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array')
    }
    for (const u of uris) {
      if (!isAllowedRedirectUri(u)) {
        return err(400, 'invalid_redirect_uri', `redirect_uri ${String(u)} is not https or loopback http`)
      }
    }

    const upstream = await fetch(`${opts.stalwartBase}/auth/register`, {
      body: JSON.stringify(body),
      headers: {
        authorization: opts.upstreamAuth,
        'content-type': 'application/json',
      },
      method: 'POST',
    })

    const text = await upstream.text()

    if (!upstream.ok) {
      // Stalwart speaks Problem Details (application/problem+json);
      // translate to RFC 6749 so the MCP SDK can parse it.
      let detail = text
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (typeof parsed.detail === 'string') {
          ;({ detail } = parsed)
        } else if (typeof parsed.error_description === 'string') {
          detail = parsed.error_description
        }
      } catch {
        // keep raw text
      }
      const statusOut = upstream.status >= 500 ? 502 : 400
      return err(
        statusOut,
        upstream.status >= 500 ? 'server_error' : 'invalid_client_metadata',
        `upstream ${upstream.status}: ${detail}`.slice(0, 500)
      )
    }

    let response: Record<string, unknown>
    try {
      response = JSON.parse(text) as Record<string, unknown>
    } catch {
      return err(502, 'server_error', 'upstream returned non-JSON success body')
    }

    // Stalwart doesn't populate token_endpoint_auth_method on the
    // response when the request didn't supply one. The MCP SDK uses
    // this field to decide whether to send client_secret on the
    // token endpoint — default it to "none" so PKCE-only public-
    // client flows work, which is the only mode Stalwart's DCR
    // currently issues.
    if (response.token_endpoint_auth_method === undefined || response.token_endpoint_auth_method === null) {
      response.token_endpoint_auth_method = 'none'
    }

    return Response.json(response, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      },
      status: 201,
    })
  }
