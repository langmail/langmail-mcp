// Reads the authenticated user's per-account time-zone preference from
// Stalwart, so the calendar tools can fall back to it when the caller omits an
// explicit `timeZone` (see the resolution chain in create-calendar-event.ts).
//
// Stalwart stores an optional IANA `timeZone` on the `AccountSettings` registry
// singleton (v0.16.13). The `sysAccountSettings*` permission is in the default
// `user` role, so the request's own bearer — the same one forwarded to CalDAV —
// can Get it. We discover the JMAP apiUrl from the session (the proven path all
// the other JMAP consumers use) and POST a single `x:AccountSettings/get`.
//
// Every failure mode here is non-fatal: an unset preference, a rejected method,
// a transport error, or an unrecognized zone all resolve to `null`, and the
// caller falls through to UTC. Failing open keeps event creation working even if
// this read breaks — the only cost is the historical UTC rendering.

import { accountIdForMail, bearerAuthorization, fetchSession, jmapTimeoutSignal } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { isValidTimeZone } from './timezone.ts'

export interface AccountSettingsConfig {
  // Stalwart base URL (STALWART_PUBLIC_URL) — the same egress the CalDAV tools
  // discover against. The JMAP apiUrl is resolved from its session resource.
  serverUrl: string
}

const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']

// Shape of the one method response we read. Only `list[].timeZone` matters; an
// `error` response (or a Stalwart that doesn't expose the registry to the user
// bearer) simply yields no zone.
interface AccountSettingsResponse {
  methodResponses?: [string, { list?: { timeZone?: unknown }[] }, string][]
}

// Performs the JMAP read and returns the stored IANA zone, or null when it is
// unset / not a zone we can resolve. Throws only on transport/protocol errors,
// which the cache layer catches.
const fetchAccountTimeZone = async (cfg: AccountSettingsConfig, token: string): Promise<string | null> => {
  const authorization = bearerAuthorization(token)
  const session = await fetchSession(cfg.serverUrl, authorization)
  const res = await fetch(session.apiUrl, {
    body: JSON.stringify({
      methodCalls: [['x:AccountSettings/get', { accountId: accountIdForMail(session), ids: ['singleton'] }, '0']],
      using: USING,
    }),
    headers: { authorization, 'content-type': 'application/json' },
    method: 'POST',
    // Bounded like every other JMAP call: this read fails open, but only if it
    // fails — an unbounded one would hang event creation behind a stalled Stalwart.
    signal: jmapTimeoutSignal(),
  })
  if (res.status !== 200) {
    throw new Error(`x:AccountSettings/get returned ${res.status}`)
  }
  const body = (await res.json()) as AccountSettingsResponse
  const [name, payload] = body.methodResponses?.[0] ?? []
  if (name !== 'x:AccountSettings/get') {
    // An `error` response (e.g. the bearer lacks the registry Get) — no zone.
    return null
  }
  const zone = payload?.list?.[0]?.timeZone
  return typeof zone === 'string' && isValidTimeZone(zone) ? zone : null
}

interface CachedTimeZone {
  exp: number
  zone: string | null
}

// A per-token cache of the resolved zone, alongside the request-scoped token
// caches. The preference changes rarely and only matters when the tool input
// omits `timeZone`, so a short TTL keeps the extra JMAP round-trip off the hot
// path without pinning a stale zone for long. `null` (no preference) is cached
// too, so a user without one doesn't re-hit Stalwart on every create.
// One resolver (and cache) is shared across the calendar tools — see mcp/handler.ts.
const DEFAULT_TTL_SECONDS = 300

export type AccountTimeZoneResolver = (token: string) => Promise<string | null>

export const makeAccountTimeZoneResolver = (
  cfg: AccountSettingsConfig,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): AccountTimeZoneResolver => {
  const cache = new Map<string, CachedTimeZone>()

  return async (token) => {
    const nowSec = Math.floor(Date.now() / 1000)
    const hit = cache.get(token)
    if (hit && hit.exp > nowSec) {
      return hit.zone
    }
    // A miss (new or expired token) is the only moment the map grows, so sweep
    // expired entries here — bounds the cache to active tokens rather than one
    // entry per distinct bearer for the life of the process. O(n) only on misses.
    for (const [key, entry] of cache) {
      if (entry.exp <= nowSec) {
        cache.delete(key)
      }
    }
    let zone: string | null = null
    try {
      zone = await fetchAccountTimeZone(cfg, token)
    } catch (err) {
      // Failure-open: log once and fall through to UTC. Never surface this to
      // the tool caller — a broken preference read must not fail event creation.
      logger.warn({ err }, 'account time-zone preference read failed; falling back to UTC')
    }
    cache.set(token, { exp: nowSec + ttlSeconds, zone })
    return zone
  }
}
