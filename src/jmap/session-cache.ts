import type { JmapSession } from "./types.ts";

export class SessionCache {
  private map = new Map<string, { session: JmapSession; exp: number }>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(principal: string): JmapSession | undefined {
    const hit = this.map.get(principal);
    if (!hit) {
      return undefined;
    }
    if (hit.exp <= Date.now()) {
      this.map.delete(principal);
      return undefined;
    }
    return hit.session;
  }

  set(principal: string, session: JmapSession): void {
    this.map.set(principal, { exp: Date.now() + this.ttlMs, session });
  }
}
