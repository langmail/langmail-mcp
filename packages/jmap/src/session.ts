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
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'JmapError'
  }
}

const TRAILING_SLASHES_RE = /\/+$/u

export const fetchSession = async (stalwartBase: string, token: string): Promise<JmapSession> => {
  const url = `${stalwartBase.replace(TRAILING_SLASHES_RE, '')}/.well-known/jmap`
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap session returned ${res.status}`)
  }
  const body = (await res.json()) as Record<string, unknown>
  const { apiUrl } = body
  const { primaryAccounts } = body
  if (typeof apiUrl !== 'string' || typeof primaryAccounts !== 'object') {
    throw new JmapError(200, 'malformed jmap session response')
  }
  return {
    apiUrl,
    primaryAccounts: primaryAccounts as Record<string, string>,
  }
}

export const accountIdForMail = (session: JmapSession): string => {
  const id = session.primaryAccounts['urn:ietf:params:jmap:mail']
  if (!id) {
    throw new JmapError(200, 'no primary mail account in session')
  }
  return id
}
