// In-memory cache mapping bearer tokens to their resolved principal, access
// level and expiry. Single-process design — see spec/02 §Decisions deferred.
//
// An entry lives at most MAX_ENTRY_SECONDS, or until the token's `exp` when
// that comes sooner. The cap is how a change at Auth reaches this server: the
// access level is read from userinfo, so a level changed under Access holds for
// the agent's next request a minute later at most, and a revoked token stops
// working here within a minute too. It costs one userinfo call per token per
// minute. See docs/reference/security/authentication.md in langmail/platform.
//
// Times are Unix seconds. Sweep on read avoids needing a background timer;
// sweep() is also exposed for explicit cleanup.

import { type AccessLevel } from '../access/levels.ts'

export const MAX_ENTRY_SECONDS = 60

export interface CachedPrincipal {
  access: AccessLevel
  // The token's own expiry.
  exp: number
  principal: string
  userId: string
}

interface Entry {
  until: number
  value: CachedPrincipal
}

const systemNowSec = () => Math.floor(Date.now() / 1000)

export class TokenCache {
  private readonly map = new Map<string, Entry>()
  private readonly nowSec: () => number

  constructor(opts: { nowSec?: () => number } = {}) {
    this.nowSec = opts.nowSec ?? systemNowSec
  }

  get size(): number {
    return this.map.size
  }

  get(token: string): CachedPrincipal | undefined {
    const hit = this.map.get(token)
    if (!hit) {
      return
    }
    if (hit.until <= this.nowSec()) {
      this.map.delete(token)
      return
    }
    return hit.value
  }

  set(token: string, value: CachedPrincipal): void {
    this.map.set(token, { until: Math.min(value.exp, this.nowSec() + MAX_ENTRY_SECONDS), value })
  }

  sweep(): void {
    const t = this.nowSec()
    for (const [k, v] of this.map) {
      if (v.until <= t) {
        this.map.delete(k)
      }
    }
  }
}
