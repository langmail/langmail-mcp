// Resolves a Better Auth-issued bearer token to a principal identity via
// the OIDC `/oauth2/userinfo` endpoint. The caller maps a throw to a 401.
//
// We don't validate the token cryptographically — Better Auth's access
// token is opaque (only the ID token is a JWT), so userinfo is the
// authoritative validation path, exactly as Stalwart validates the same
// token for JMAP. See docs/reference/security/authentication.md.
//
// The principal is the `email` claim: Better Auth rewrites it to the user's
// `username@langmail.me` mailbox address (getAdditionalUserInfoClaim) and
// suppresses it for a user with no active mailbox. Requiring it here means a
// non-mailbox Google identity is rejected with a clean 401 rather than
// failing confusingly downstream in JMAP/CalDAV.

export interface UserinfoResult {
  // Unix seconds
  exp: number
  principal: string
}

export class UserinfoError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'UserinfoError'
  }
}

const DEFAULT_TTL_SECONDS = 3600
const TRAILING_SLASHES_RE = /\/+$/u

export const fetchUserinfo = async (authIssuer: string, token: string): Promise<UserinfoResult> => {
  const url = `${authIssuer.replace(TRAILING_SLASHES_RE, '')}/oauth2/userinfo`
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) {
    throw new UserinfoError(res.status, `userinfo returned ${res.status}`)
  }
  const body = (await res.json()) as Record<string, unknown>
  const principal = typeof body.email === 'string' ? body.email : undefined
  if (!principal) {
    // Better Auth's getAdditionalUserInfoClaim asserts the mailbox address as
    // `email` for any mailbox user irrespective of requested scope, and
    // suppresses it only when the user has no active langmail.me mailbox. So a
    // missing `email` claim means "no mailbox" — the token can't act on one.
    throw new UserinfoError(200, 'userinfo response missing email claim (no active mailbox)')
  }
  const exp = typeof body.exp === 'number' ? (body.exp as number) : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS
  return { exp, principal }
}
