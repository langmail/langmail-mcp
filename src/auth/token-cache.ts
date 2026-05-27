// In-memory cache mapping bearer tokens to their resolved principal +
// expiry. Single-process design — see spec/02 §Decisions deferred.
//
// `exp` is Unix seconds. Sweep on read avoids needing a background
// timer; sweep() is also exposed for explicit cleanup.

export interface CachedPrincipal {
  exp: number
  principal: string
}

const nowSec = () => Math.floor(Date.now() / 1000)

export class TokenCache {
  private readonly map = new Map<string, CachedPrincipal>()

  get size(): number {
    return this.map.size
  }

  get(token: string): CachedPrincipal | undefined {
    const hit = this.map.get(token)
    if (!hit) {
      return
    }
    if (hit.exp <= nowSec()) {
      this.map.delete(token)
      return
    }
    return hit
  }

  set(token: string, entry: CachedPrincipal): void {
    this.map.set(token, entry)
  }

  sweep(): void {
    const t = nowSec()
    for (const [k, v] of this.map) {
      if (v.exp <= t) {
        this.map.delete(k)
      }
    }
  }
}
