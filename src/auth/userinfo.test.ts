import { describe, test, expect, mock } from "bun:test";
import { fetchUserinfo, UserinfoError } from "./userinfo.ts";

const STALWART = "https://mail.example.com";

function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("fetchUserinfo", () => {
  test("resolves principal + exp from /auth/userinfo", async () => {
    const f = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${STALWART}/auth/userinfo`);
      expect((init?.headers as Record<string, string>)?.["authorization"])
        .toBe("Bearer abc");
      return new Response(
        JSON.stringify({
          preferred_username: "alice",
          exp: 1_900_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const got = await withFetch(f, () => fetchUserinfo(STALWART, "abc"));
    expect(got).toEqual({ principal: "alice", exp: 1_900_000_000 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("falls back to `sub` if preferred_username missing", async () => {
    const f = mock(async () =>
      new Response(JSON.stringify({ sub: "bob", exp: 1_900_000_000 }), {
        status: 200,
      }),
    );
    const got = await withFetch(f, () => fetchUserinfo(STALWART, "tok"));
    expect(got.principal).toBe("bob");
  });

  test("throws UserinfoError with status on non-200", async () => {
    const f = mock(async () => new Response("nope", { status: 401 }));
    await withFetch(f, async () => {
      const err = await fetchUserinfo(STALWART, "tok").catch((e) => e);
      expect(err).toBeInstanceOf(UserinfoError);
      expect((err as UserinfoError).status).toBe(401);
    });
  });

  test("throws UserinfoError when response lacks both username and sub", async () => {
    const f = mock(async () =>
      new Response(JSON.stringify({ exp: 1_900_000_000 }), { status: 200 }),
    );
    await withFetch(f, async () => {
      const err = await fetchUserinfo(STALWART, "tok").catch((e) => e);
      expect(err).toBeInstanceOf(UserinfoError);
    });
  });

  test("synthesises exp ~1h ahead when response has no exp", async () => {
    const f = mock(async () =>
      new Response(JSON.stringify({ preferred_username: "alice" }), {
        status: 200,
      }),
    );
    const before = Math.floor(Date.now() / 1000);
    const got = await withFetch(f, () => fetchUserinfo(STALWART, "tok"));
    expect(got.exp).toBeGreaterThanOrEqual(before + 60);
    expect(got.exp).toBeLessThanOrEqual(before + 7200);
  });
});
