import { describe, expect, mock, test } from 'bun:test'

import type { AuthContext } from './middleware.ts'
import { createAuthMiddleware } from './middleware.ts'
import { TokenCache } from './token-cache.ts'

const STALWART = 'https://mail.example.com'
const RESOURCE = 'https://mcp.example.com'

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

const makeMw = (opts: { cache?: TokenCache } = {}) =>
  createAuthMiddleware({
    cache: opts.cache ?? new TokenCache(),
    publicUrl: RESOURCE,
    stalwartBase: STALWART,
  })

describe('auth middleware', () => {
  test('returns 401 + WWW-Authenticate when Authorization header is missing', async () => {
    const mw = makeMw()
    const out = await mw(new Request('https://mcp.example.com/mcp'))
    expect(out).toBeInstanceOf(Response)
    const res = out as Response
    expect(res.status).toBe(401)
    const wa = res.headers.get('www-authenticate') ?? ''
    expect(wa.toLowerCase()).toContain('bearer')
    expect(wa).toContain(`resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`)
  })

  test('returns 401 when Authorization scheme is not Bearer', async () => {
    const mw = makeMw()
    const out = await mw(
      new Request('https://mcp.example.com/mcp', {
        headers: { authorization: 'Basic abc' },
      })
    )
    expect((out as Response).status).toBe(401)
  })

  test('returns 401 when userinfo rejects the token', async () => {
    const cache = new TokenCache()
    const mw = makeMw({ cache })
    const f = mock(() => Promise.resolve(new Response('nope', { status: 401 })))
    const out = await withFetch(f, () =>
      mw(
        new Request('https://mcp.example.com/mcp', {
          headers: { authorization: 'Bearer bad' },
        })
      )
    )
    expect((out as Response).status).toBe(401)
    expect(cache.size).toBe(0)
  })

  test('populates principal and caches on success', async () => {
    const cache = new TokenCache()
    const mw = makeMw({ cache })
    const f = mock(() =>
      Promise.resolve(
        Response.json(
          {
            exp: Math.floor(Date.now() / 1000) + 60,
            preferred_username: 'alice',
          },
          { status: 200 }
        )
      )
    )
    const out = await withFetch(f, () =>
      mw(
        new Request('https://mcp.example.com/mcp', {
          headers: { authorization: 'Bearer good' },
        })
      )
    )
    expect(out).not.toBeInstanceOf(Response)
    const ctx = out as AuthContext
    expect(ctx.principal).toBe('alice')
    expect(ctx.token).toBe('good')
    expect(cache.size).toBe(1)
  })

  test('subsequent calls within exp hit the cache, not the network', async () => {
    const cache = new TokenCache()
    cache.set('good', {
      exp: Math.floor(Date.now() / 1000) + 60,
      principal: 'alice',
    })
    const mw = makeMw({ cache })
    const f = mock(() => {
      throw new Error('network should not be called')
    })
    const out = await withFetch(f, () =>
      mw(
        new Request('https://mcp.example.com/mcp', {
          headers: { authorization: 'Bearer good' },
        })
      )
    )
    const ctx = out as AuthContext
    expect(ctx.principal).toBe('alice')
    expect(f).not.toHaveBeenCalled()
  })
})
