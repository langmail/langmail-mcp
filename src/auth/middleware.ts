// Authentication boundary for the MCP resource server.
//
// `authenticate(request)` returns either:
//   - an AuthContext (principal + raw token, for downstream JMAP calls), or
//   - a 401 Response with a WWW-Authenticate header pointing at our
//     RFC 9728 protected-resource metadata so MCP clients can self-
//     bootstrap discovery.
//
// Token validity is established by calling Better Auth's /oauth2/userinfo
// once per token, then caching the (principal, exp) tuple until the
// token expires. See docs/reference/security/authentication.md.

import { type AccessLevel } from '../access/levels.ts'
import { MCP_SCOPES } from './scopes.ts'
import { type TokenCache } from './token-cache.ts'
import { fetchUserinfo, UserinfoError } from './userinfo.ts'

export interface AuthContext {
  // The agent's access level (src/access/levels.ts). Every connection runs at
  // Everything until it is read from Auth (langmail/platform#1452).
  access: AccessLevel
  exp: number
  principal: string
  token: string
  // The `auth.user` id (userinfo's `sub`), for the agent-activity record.
  userId: string
}

export interface AuthMiddlewareOptions {
  // Better Auth OIDC issuer, e.g. https://auth.langmail.me/api/auth. The
  // per-token principal is resolved at `${authIssuer}/oauth2/userinfo`.
  authIssuer: string
  cache: TokenCache
  publicUrl: string
}

export type AuthMiddleware = (req: Request) => Promise<AuthContext | Response>

const BEARER_RE = /^Bearer\s+(.+)$/iu

export const createAuthMiddleware = (opts: AuthMiddlewareOptions): AuthMiddleware => {
  // `scope` tells a client following the MCP spec's scope selection which
  // scopes to request on authorize (RFC 6750 §3).
  const challenge = `Bearer realm="mcp", resource_metadata="${opts.publicUrl}/.well-known/oauth-protected-resource", scope="${MCP_SCOPES.join(' ')}"`

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
      return { access: 'everything', exp: cached.exp, principal: cached.principal, token, userId: cached.userId }
    }

    try {
      const { principal, exp, userId } = await fetchUserinfo(opts.authIssuer, token)
      opts.cache.set(token, { exp, principal, userId })
      return { access: 'everything', exp, principal, token, userId }
    } catch (error) {
      if (error instanceof UserinfoError) {
        return unauth('invalid_token')
      }
      throw error
    }
  }
}
