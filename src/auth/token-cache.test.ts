import { describe, test, expect } from "bun:test";

import { TokenCache } from "./token-cache.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("TokenCache", () => {
  test("get returns undefined for unknown token", () => {
    const c = new TokenCache();
    expect(c.get("nope")).toBeUndefined();
  });

  test("set then get within exp returns the entry", () => {
    const c = new TokenCache();
    const entry = { exp: now() + 60, principal: "alice@example.com" };
    c.set("t1", entry);
    expect(c.get("t1")).toEqual(entry);
  });

  test("expired entries are evicted lazily on read", () => {
    const c = new TokenCache();
    c.set("t1", { exp: now() - 1, principal: "alice" });
    expect(c.get("t1")).toBeUndefined();
    // Internal map should no longer contain the key.
    expect(c.size).toBe(0);
  });

  test("set overwrites a previous entry for the same token", () => {
    const c = new TokenCache();
    c.set("t1", { exp: now() + 60, principal: "alice" });
    c.set("t1", { exp: now() + 60, principal: "bob" });
    expect(c.get("t1")?.principal).toBe("bob");
  });

  test("sweep removes all expired entries", () => {
    const c = new TokenCache();
    c.set("dead", { exp: now() - 10, principal: "x" });
    c.set("alive", { exp: now() + 60, principal: "y" });
    c.sweep();
    expect(c.size).toBe(1);
    expect(c.get("alive")?.principal).toBe("y");
    expect(c.get("dead")).toBeUndefined();
  });
});
