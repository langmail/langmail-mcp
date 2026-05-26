import { describe, test, expect, mock } from "bun:test";

import { TokenCache } from "./auth/token-cache.ts";
import { createRoutes } from "./handler.ts";

const STALWART = "https://mail.example.com";
const PUBLIC = "https://mcp.example.com";

const makeRoutes = (opts: { cache?: TokenCache } = {}) =>
  createRoutes({
    cache: opts.cache,
    publicUrl: PUBLIC,
    stalwartUrl: STALWART,
  });

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
      new Request(`${PUBLIC}/.well-known/oauth-authorization-server`)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["issuer"]).toBe(PUBLIC);
    expect(body["resource"]).toBe(PUBLIC);
    expect(body["authorization_endpoint"]).toBe(`${STALWART}/login`);
    expect(body["token_endpoint"]).toBe(`${STALWART}/auth/token`);
    expect(body["code_challenge_methods_supported"]).toContain("S256");
    // We proxy DCR — registration_endpoint must point at us, not Stalwart.
    expect(body["registration_endpoint"]).toBe(`${PUBLIC}/auth/register`);
  });

  test("POST /auth/register proxies DCR (503 when no upstream creds)", async () => {
    const r = makeRoutes();
    const res = await r.fetch(
      new Request(`${PUBLIC}/auth/register`, {
        body: JSON.stringify({ redirect_uris: ["https://x/cb"] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("temporarily_unavailable");
  });

  test("GET /.well-known/oauth-protected-resource is valid PRM (RFC 9728)", async () => {
    const r = makeRoutes();
    const res = await r.fetch(
      new Request(`${PUBLIC}/.well-known/oauth-protected-resource`)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["resource"]).toBe(PUBLIC);
    expect(body["authorization_servers"]).toEqual([PUBLIC]);
    expect(body["bearer_methods_supported"]).toEqual(["header"]);
  });

  test("GET /unknown returns 404", async () => {
    const r = makeRoutes();
    const res = await r.fetch(new Request(`${PUBLIC}/nope`));
    expect(res.status).toBe(404);
  });

  test("POST /mcp without Authorization returns 401 with PRM challenge", async () => {
    const r = makeRoutes();
    const res = await r.fetch(new Request(`${PUBLIC}/mcp`, { method: "POST" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `${PUBLIC}/.well-known/oauth-protected-resource`
    );
  });

  test("POST /mcp with valid bearer reaches the (stub) MCP handler", async () => {
    const cache = new TokenCache();
    cache.set("good", {
      exp: Math.floor(Date.now() / 1000) + 60,
      principal: "alice",
    });
    const r = makeRoutes({ cache });
    const f = mock(() => {
      throw new Error("network should not be called");
    });
    const res = await withFetch(f, () =>
      r.fetch(
        new Request(`${PUBLIC}/mcp`, {
          headers: { authorization: "Bearer good" },
          method: "POST",
        })
      )
    );
    // Phase 1 stub: 501 with the principal echoed back.
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["principal"]).toBe("alice");
  });
});
