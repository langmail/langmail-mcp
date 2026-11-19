// The reachability probes MCP's /readyz runs. The runner that times them out
// and caches a ready result is `readiness-runner.ts`, a copy of the one auth uses.

import { type Check } from './readiness-runner.ts'

const TRAILING_SLASHES_RE = /\/+$/u

// Reachability of Better Auth's userinfo endpoint — the exact call the auth
// middleware makes per token to validate a bearer. Any HTTP response (the
// expected 401 for an unauthenticated probe) means the egress path is alive;
// a thrown socket error / timeout means it is not.
export const authReachable =
  (authIssuer: string): Check =>
  async (timeoutMs) => {
    const base = authIssuer.replace(TRAILING_SLASHES_RE, '')
    const res = await fetch(`${base}/oauth2/userinfo`, { signal: AbortSignal.timeout(timeoutMs) })
    return `HTTP ${res.status}`
  }

// Reachability of Stalwart's JMAP/DAV egress — where the validated bearer is
// forwarded for every tool call. Probes the JMAP session endpoint; any HTTP
// response (it answers 200 even unauthenticated) proves the path is alive.
export const stalwartReachable =
  (stalwartUrl: string): Check =>
  async (timeoutMs) => {
    const base = stalwartUrl.replace(TRAILING_SLASHES_RE, '')
    const res = await fetch(`${base}/jmap/session`, { signal: AbortSignal.timeout(timeoutMs) })
    return `HTTP ${res.status}`
  }
