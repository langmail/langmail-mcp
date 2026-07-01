import { type JmapSession } from './types.ts'

export class SessionCache {
  private readonly map = new Map<string, { session: JmapSession; exp: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  get(principal: string): JmapSession | undefined {
    const hit = this.map.get(principal)
    if (!hit) {
      return
    }
    if (hit.exp <= Date.now()) {
      this.map.delete(principal)
      return
    }
    return hit.session
  }

  set(principal: string, session: JmapSession): void {
    this.map.set(principal, { exp: Date.now() + this.ttlMs, session })
  }
}
