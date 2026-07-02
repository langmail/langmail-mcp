// Shared JMAP live-deps plumbing: a per-token session cache plus the
// account-id resolution every JMAP call needs. Extracted so consumers
// (MCP tools, the email-agent poller) don't each re-implement it (DRY).

import { accountIdForMail, fetchSession } from './session.ts'
import { type JmapSession } from './types.ts'

export interface JmapLive {
  getSession: (token: string) => Promise<JmapSession>
  resolveAccountId: (token: string) => Promise<string>
}

export const makeJmapLive = (stalwartUrl: string): JmapLive => {
  // Cache by token (single process) rather than by principal — cheaper than
  // re-deriving the principal from another userinfo call. The JMAP session
  // resource is stable for a mailbox's lifetime.
  const sessionByToken = new Map<string, JmapSession>()

  const getSession = async (token: string): Promise<JmapSession> => {
    const hit = sessionByToken.get(token)
    if (hit) {
      return hit
    }
    const session = await fetchSession(stalwartUrl, token)
    sessionByToken.set(token, session)
    return session
  }

  return {
    getSession,
    resolveAccountId: async (token) => accountIdForMail(await getSession(token)),
  }
}
