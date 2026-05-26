import { describe, test, expect, mock } from "bun:test";

import { fetchSession, JmapError } from "./session.ts";

const STALWART = "https://mail.example.com";

const withFetch = <T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
};

describe("fetchSession", () => {
  test("hits /.well-known/jmap with bearer and parses primaryAccount", async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(`${STALWART}/.well-known/jmap`);
      expect((init?.headers as Record<string, string>)?.["authorization"]).toBe(
        "Bearer tok"
      );
      return Promise.resolve(
        Response.json(
          {
            apiUrl: `${STALWART}/jmap/`,
            primaryAccounts: {
              "urn:ietf:params:jmap:mail": "acct-1",
            },
          },
          { status: 200 }
        )
      );
    });
    const s = await withFetch(f, () => fetchSession(STALWART, "tok"));
    expect(s.apiUrl).toBe(`${STALWART}/jmap/`);
    expect(s.primaryAccounts["urn:ietf:params:jmap:mail"]).toBe("acct-1");
  });

  test("throws JmapError on non-200", async () => {
    const f = mock(() =>
      Promise.resolve(new Response("nope", { status: 401 }))
    );
    await withFetch(f, async () => {
      const err = await fetchSession(STALWART, "tok").catch((error) => error);
      expect(err).toBeInstanceOf(JmapError);
      expect((err as JmapError).status).toBe(401);
    });
  });
});
