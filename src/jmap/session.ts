// JMAP session discovery + a small per-principal cache.
//
// The session resource changes rarely (accountId is stable for the
// lifetime of a mailbox), so we cache it long. The cache key is the
// principal, not the token — multiple tokens for the same user share
// one entry.

import type { JmapSession } from "./types.ts";

export class JmapError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "JmapError";
  }
}

export async function fetchSession(
  stalwartBase: string,
  token: string,
): Promise<JmapSession> {
  const url = `${stalwartBase.replace(/\/+$/, "")}/.well-known/jmap`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap session returned ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const apiUrl = body["apiUrl"];
  const primaryAccounts = body["primaryAccounts"];
  if (typeof apiUrl !== "string" || typeof primaryAccounts !== "object") {
    throw new JmapError(200, "malformed jmap session response");
  }
  return {
    apiUrl,
    primaryAccounts: primaryAccounts as Record<string, string>,
  };
}

export class SessionCache {
  private map = new Map<string, { session: JmapSession; exp: number }>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(principal: string): JmapSession | undefined {
    const hit = this.map.get(principal);
    if (!hit) return undefined;
    if (hit.exp <= Date.now()) {
      this.map.delete(principal);
      return undefined;
    }
    return hit.session;
  }

  set(principal: string, session: JmapSession): void {
    this.map.set(principal, { session, exp: Date.now() + this.ttlMs });
  }
}

export function accountIdForMail(session: JmapSession): string {
  const id = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!id) throw new JmapError(200, "no primary mail account in session");
  return id;
}
