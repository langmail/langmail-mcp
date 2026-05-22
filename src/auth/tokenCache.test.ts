import { describe, test, expect } from "bun:test";
import { TokenCache } from "./tokenCache.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("TokenCache", () => {
  test("get returns undefined for unknown token", () => {
    const c = new TokenCache();
    expect(c.get("nope")).toBeUndefined();
  });

  test("set then get within exp returns the entry", () => {
    const c = new TokenCache();
    const entry = { principal: "alice@example.com", exp: now() + 60 };
    c.set("t1", entry);
    expect(c.get("t1")).toEqual(entry);
  });

  test("expired entries are evicted lazily on read", () => {
    const c = new TokenCache();
    c.set("t1", { principal: "alice", exp: now() - 1 });
    expect(c.get("t1")).toBeUndefined();
    // Internal map should no longer contain the key.
    expect(c.size).toBe(0);
  });

  test("set overwrites a previous entry for the same token", () => {
    const c = new TokenCache();
    c.set("t1", { principal: "alice", exp: now() + 60 });
    c.set("t1", { principal: "bob", exp: now() + 60 });
    expect(c.get("t1")?.principal).toBe("bob");
  });

  test("sweep removes all expired entries", () => {
    const c = new TokenCache();
    c.set("dead", { principal: "x", exp: now() - 10 });
    c.set("alive", { principal: "y", exp: now() + 60 });
    c.sweep();
    expect(c.size).toBe(1);
    expect(c.get("alive")?.principal).toBe("y");
    expect(c.get("dead")).toBeUndefined();
  });
});
