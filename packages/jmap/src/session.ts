// JMAP session discovery.
//
// The session resource changes rarely (accountId is stable for the
// lifetime of a mailbox), so callers cache it (see `live.ts`). Auth is
// caller-provided: MCP passes a validated client bearer, the email-agent
// passes a credential minted by the auth service — this module never
// mints tokens itself.

import { type JmapSession } from './types.ts'

export class JmapError extends Error {
  status: number
  // RFC 8620 method-level error type (e.g. "cannotCalculateChanges") when the
  // server answered the call with an `error` method response; undefined for
  // transport-level failures. Lets callers branch on recoverable conditions.
  errorType: string | undefined
  constructor(status: number, message: string, errorType?: string) {
    super(message)
    this.status = status
    this.errorType = errorType
    this.name = 'JmapError'
  }
}

const TRAILING_SLASHES_RE = /\/+$/u

// Build a Bearer Authorization header from a raw OAuth token. Every JMAP
// wrapper takes the *full* header value, so Basic credentials (the agent's
// stalwart-credential seam) and OAuth bearers (MCP) share one seam.
export const bearerAuthorization = (token: string): string => `Bearer ${token}`

export const fetchSession = async (stalwartBase: string, authorization: string): Promise<JmapSession> => {
  const url = `${stalwartBase.replace(TRAILING_SLASHES_RE, '')}/.well-known/jmap`
  const res = await fetch(url, {
    headers: { authorization },
  })
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap session returned ${res.status}`)
  }
  const body = (await res.json()) as Record<string, unknown>
  const { apiUrl } = body
  const { downloadUrl } = body
  const { uploadUrl } = body
  const { primaryAccounts } = body
  // downloadUrl and uploadUrl are mandatory in the session resource
  // (RFC 8620 §2) and Stalwart always sends them — a session without
  // either is malformed.
  if (
    typeof apiUrl !== 'string' ||
    typeof downloadUrl !== 'string' ||
    typeof uploadUrl !== 'string' ||
    typeof primaryAccounts !== 'object'
  ) {
    throw new JmapError(200, 'malformed jmap session response')
  }
  return {
    apiUrl,
    downloadUrl,
    primaryAccounts: primaryAccounts as Record<string, string>,
    uploadUrl,
  }
}

export const accountIdForMail = (session: JmapSession): string => {
  const id = session.primaryAccounts['urn:ietf:params:jmap:mail']
  if (!id) {
    throw new JmapError(200, 'no primary mail account in session')
  }
  return id
}

// Stalwart serves the Sieve capability (RFC 9661) on the same account as
// mail; the fallback covers a session resource that only advertises the
// mail primary.
export const accountIdForSieve = (session: JmapSession): string =>
  session.primaryAccounts['urn:ietf:params:jmap:sieve'] ?? accountIdForMail(session)
