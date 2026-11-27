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
//
// The `sub` claim is the user's `auth.user` id, which the agent-activity
// record (activity/record-agent-activity.ts) is keyed on.
//
// The `langmail_access` claim is the access level the user gave the token's
// agent (src/access/levels.ts). Auth leaves it out only when its lookup fails,
// so a missing or unknown value is our bug: the agent runs at Read only, which
// never widens what it can do, and we log an error. Rejecting the token instead
// would disconnect the agent for that bug.

import { type AccessLevel, isAccessLevel } from '../access/levels.ts'
import { logger } from '../logger/index.ts'

export const ACCESS_CLAIM = 'langmail_access'

export interface UserinfoResult {
  access: AccessLevel
  // Unix seconds
  exp: number
  principal: string
  userId: string
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
// Token validation guards every /mcp request, and Better Auth is expected to
// answer fast — so this deadline is short. Without it a stalled auth service
// hangs every request indefinitely instead of failing them visibly.
const USERINFO_TIMEOUT_MS = 5000

const readAccess = (claim: unknown): AccessLevel => {
  if (isAccessLevel(claim)) {
    return claim
  }
  logger.error(
    { claim: typeof claim === 'string' ? claim : typeof claim },
    `userinfo ${ACCESS_CLAIM} claim is missing or not an access level; running the agent at read-only`
  )
  return 'read-only'
}

export const fetchUserinfo = async (authIssuer: string, token: string): Promise<UserinfoResult> => {
  const url = `${authIssuer.replace(TRAILING_SLASHES_RE, '')}/oauth2/userinfo`
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
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
  const userId = typeof body.sub === 'string' ? body.sub : undefined
  if (!userId) {
    throw new UserinfoError(200, 'userinfo response missing sub claim')
  }
  const access = readAccess(body[ACCESS_CLAIM])
  const exp = typeof body.exp === 'number' ? (body.exp as number) : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS
  return { access, exp, principal, userId }
}
