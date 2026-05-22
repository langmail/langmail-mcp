import { describe, test, expect, mock } from "bun:test";
import { createRoutes } from "./handler.ts";
import { TokenCache } from "./auth/tokenCache.ts";

const STALWART = "https://mail.example.com";
const PUBLIC = "https://mcp.example.com";

function makeRoutes(opts: { cache?: TokenCache } = {}) {
  return createRoutes({
    publicUrl: PUBLIC,
    stalwartUrl: STALWART,
    cache: opts.cache,
  });
}

function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("routes", () => {
  test("GET /healthz returns 200 ok", async () => {
    const r = makeRoutes();
    const res = await r.fetch(new Request(`${PUBLIC}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  test("GET /.well-known/oauth-authorization-server is valid AS metadata", async () => {
    const r = makeRoutes();
    const res = await r.fetch(
      new Request(`${PUBLIC}/.well-known/oauth-authorization-server`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["issuer"]).toBe(STALWART);
    expect(body["resource"]).toBe(PUBLIC);
    expect(body["code_challenge_methods_supported"]).toContain("S256");
  });

  test("GET /.well-known/oauth-protected-resource is valid PRM (RFC 9728)", async () => {
    const r = makeRoutes();
    const res = await r.fetch(
      new Request(`${PUBLIC}/.well-known/oauth-protected-resource`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["resource"]).toBe(PUBLIC);
    expect(body["authorization_servers"]).toEqual([STALWART]);
    expect(body["bearer_methods_supported"]).toEqual(["header"]);
  });

  test("GET /unknown returns 404", async () => {
    const r = makeRoutes();
    const res = await r.fetch(new Request(`${PUBLIC}/nope`));
    expect(res.status).toBe(404);
  });

  test("POST /mcp without Authorization returns 401 with PRM challenge", async () => {
    const r = makeRoutes();
    const res = await r.fetch(
      new Request(`${PUBLIC}/mcp`, { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `${PUBLIC}/.well-known/oauth-protected-resource`,
    );
  });

  test("POST /mcp with valid bearer reaches the (stub) MCP handler", async () => {
    const cache = new TokenCache();
    cache.set("good", {
      principal: "alice",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const r = makeRoutes({ cache });
    const f = mock(async () => {
      throw new Error("network should not be called");
    });
    const res = await withFetch(f, () =>
      r.fetch(
        new Request(`${PUBLIC}/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer good" },
        }),
      ),
    );
    // Phase 1 stub: 501 with the principal echoed back.
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["principal"]).toBe("alice");
  });
});
