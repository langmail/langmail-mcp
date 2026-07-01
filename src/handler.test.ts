import { describe, expect, mock, test } from 'bun:test'

import { TokenCache } from './auth/token-cache.ts'
import { createRoutes } from './handler.ts'

const STALWART = 'https://mail.example.com'
const AUTH = 'https://auth.example.com/api/auth'
const PUBLIC = 'https://mcp.example.com'

const makeRoutes = (opts: { cache?: TokenCache } = {}) =>
  createRoutes({
    authIssuer: AUTH,
    cache: opts.cache,
    publicUrl: PUBLIC,
    stalwartUrl: STALWART,
  })

const withFetch = <T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

describe('routes', () => {
  test('GET /healthz returns 200 ok', async () => {
    const r = makeRoutes()
    const res = await r.fetch(new Request(`${PUBLIC}/healthz`))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok\n')
  })

  test('GET /.well-known/oauth-authorization-server advertises Better Auth endpoints', async () => {
    const r = makeRoutes()
    const res = await r.fetch(new Request(`${PUBLIC}/.well-known/oauth-authorization-server`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Issuer stays us (the facade the SDK reads); every OAuth leg points at Better Auth.
    expect(body.issuer).toBe(PUBLIC)
    expect(body.resource).toBe(PUBLIC)
    expect(body.authorization_endpoint).toBe(`${AUTH}/oauth2/authorize`)
    expect(body.token_endpoint).toBe(`${AUTH}/oauth2/token`)
    expect(body.userinfo_endpoint).toBe(`${AUTH}/oauth2/userinfo`)
    // DCR is Better Auth's now — no proxy on us.
    expect(body.registration_endpoint).toBe(`${AUTH}/oauth2/register`)
    expect(body.code_challenge_methods_supported).toContain('S256')
    // `email` must be requestable — Stalwart's mapping + our principal need it.
    expect(body.scopes_supported).toContain('email')
  })

  test('GET /.well-known/oauth-protected-resource is valid PRM (RFC 9728)', async () => {
    const r = makeRoutes()
    const res = await r.fetch(new Request(`${PUBLIC}/.well-known/oauth-protected-resource`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.resource).toBe(PUBLIC)
    expect(body.authorization_servers).toEqual([PUBLIC])
    expect(body.bearer_methods_supported).toEqual(['header'])
  })

  test('GET /unknown returns 404', async () => {
    const r = makeRoutes()
    const res = await r.fetch(new Request(`${PUBLIC}/nope`))
    expect(res.status).toBe(404)
  })

  test('POST /mcp without Authorization returns 401 with PRM challenge', async () => {
    const r = makeRoutes()
    const res = await r.fetch(new Request(`${PUBLIC}/mcp`, { method: 'POST' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(`${PUBLIC}/.well-known/oauth-protected-resource`)
  })

  test('POST /mcp with valid bearer reaches the (stub) MCP handler', async () => {
    const cache = new TokenCache()
    cache.set('good', {
      exp: Math.floor(Date.now() / 1000) + 60,
      principal: 'alice',
    })
    const r = makeRoutes({ cache })
    const f = mock(() => {
      throw new Error('network should not be called')
    })
    const res = await withFetch(f, () =>
      r.fetch(
        new Request(`${PUBLIC}/mcp`, {
          headers: { authorization: 'Bearer good' },
          method: 'POST',
        })
      )
    )
    // Phase 1 stub: 501 with the principal echoed back.
    expect(res.status).toBe(501)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.principal).toBe('alice')
  })

  test('GET /readyz returns 200 when Better Auth and Stalwart are reachable', async () => {
    const r = makeRoutes()
    const res = await withFetch(
      () => Promise.resolve(new Response(null, { status: 401 })),
      () => r.fetch(new Request(`${PUBLIC}/readyz`))
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; checks: Record<string, string> }
    expect(body.status).toBe('ready')
    expect(body.checks.auth).toBe('HTTP 401')
    expect(body.checks.stalwart).toBe('HTTP 401')
  })

  test('GET /readyz returns 503 when a dependency is unreachable', async () => {
    const r = makeRoutes()
    const res = await withFetch(
      () => Promise.reject(new Error('ConnectionRefused')),
      () => r.fetch(new Request(`${PUBLIC}/readyz`))
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('not_ready')
  })
})
