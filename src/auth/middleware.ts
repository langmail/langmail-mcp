// Authentication boundary for the MCP resource server.
//
// `authenticate(request)` returns either:
//   - an AuthContext (principal + raw token, for downstream JMAP calls), or
//   - a 401 Response with a WWW-Authenticate header pointing at our
//     RFC 9728 protected-resource metadata so MCP clients can self-
//     bootstrap discovery.
//
// Token validity is established by calling Stalwart's /auth/userinfo
// once per token, then caching the (principal, exp) tuple until the
// token expires. See spec/02 §Architecture.

import { type TokenCache } from './token-cache.ts'
import { fetchUserinfo, UserinfoError } from './userinfo.ts'

export interface AuthContext {
  exp: number
  principal: string
  token: string
}

export interface AuthMiddlewareOptions {
  cache: TokenCache
  publicUrl: string
  stalwartBase: string
}

export type AuthMiddleware = (req: Request) => Promise<AuthContext | Response>

const BEARER_RE = /^Bearer\s+(.+)$/iu

export const createAuthMiddleware = (opts: AuthMiddlewareOptions): AuthMiddleware => {
  const challenge = `Bearer realm="mcp", resource_metadata="${opts.publicUrl}/.well-known/oauth-protected-resource"`

  const unauth = (error?: string): Response => {
    const wa = error ? `${challenge}, error="${error}"` : challenge
    return new Response(null, {
      headers: { 'www-authenticate': wa },
      status: 401,
    })
  }

  return async (req) => {
    const header = req.headers.get('authorization')
    if (!header) {
      return unauth()
    }
    const m = BEARER_RE.exec(header)
    if (!m) {
      return unauth('invalid_token')
    }
    const token = (m[1] ?? '').trim()

    const cached = opts.cache.get(token)
    if (cached) {
      return { exp: cached.exp, principal: cached.principal, token }
    }

    try {
      const { principal, exp } = await fetchUserinfo(opts.stalwartBase, token)
      opts.cache.set(token, { exp, principal })
      return { exp, principal, token }
    } catch (error) {
      if (error instanceof UserinfoError) {
        return unauth('invalid_token')
      }
      throw error
    }
  }
}
