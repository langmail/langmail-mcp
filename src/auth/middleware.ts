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

import { fetchUserinfo, UserinfoError } from "./userinfo.ts";
import { TokenCache } from "./tokenCache.ts";

export interface AuthContext {
  principal: string;
  token: string;
  exp: number;
}

export interface AuthMiddlewareOptions {
  stalwartBase: string;
  publicUrl: string;
  cache: TokenCache;
}

export type AuthMiddleware = (
  req: Request,
) => Promise<AuthContext | Response>;

export function createAuthMiddleware(
  opts: AuthMiddlewareOptions,
): AuthMiddleware {
  const challenge =
    `Bearer realm="mcp", ` +
    `resource_metadata="${opts.publicUrl}/.well-known/oauth-protected-resource"`;

  const unauth = (error?: string): Response => {
    const wa = error ? `${challenge}, error="${error}"` : challenge;
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": wa },
    });
  };

  return async (req) => {
    const header = req.headers.get("authorization");
    if (!header) return unauth();
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return unauth("invalid_token");
    const token = m[1]!.trim();

    const cached = opts.cache.get(token);
    if (cached) {
      return { principal: cached.principal, token, exp: cached.exp };
    }

    try {
      const { principal, exp } = await fetchUserinfo(opts.stalwartBase, token);
      opts.cache.set(token, { principal, exp });
      return { principal, token, exp };
    } catch (err) {
      if (err instanceof UserinfoError) return unauth("invalid_token");
      throw err;
    }
  };
}
