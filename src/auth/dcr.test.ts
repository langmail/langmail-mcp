import { describe, expect, mock, test } from 'bun:test'

import { createDcrHandler } from './dcr.ts'

const STALWART = 'https://mail.example.com'
const AUTH = 'Basic YWRtaW46cHc='

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

const req = (body: unknown, init: RequestInit = {}): Request =>
  new Request('https://mcp.example.com/auth/register', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    ...init,
  })

describe('DCR proxy', () => {
  test('rejects non-POST with RFC-6749 error', async () => {
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const res = await h(new Request('https://mcp.example.com/auth/register'))
    expect(res.status).toBe(405)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
  })

  test('returns 503 when upstream credentials are missing', async () => {
    const h = createDcrHandler({ stalwartBase: STALWART })
    const res = await h(req({ redirect_uris: ['https://x/cb'] }))
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('temporarily_unavailable')
  })

  test('rejects empty / missing redirect_uris', async () => {
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const r1 = await h(req({}))
    expect(r1.status).toBe(400)
    const r2 = await h(req({ redirect_uris: [] }))
    expect(r2.status).toBe(400)
  })

  test('rejects non-https / non-loopback redirect_uris', async () => {
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const res = await h(req({ redirect_uris: ['http://evil.example/cb'] }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_redirect_uri')
  })

  test('accepts https and http loopback redirects', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const upstream = mock((url: string, init?: RequestInit) => {
      calls.push({ init, url })
      return Promise.resolve(
        Response.json(
          {
            client_id: 'abc123',
            redirect_uris: ['http://localhost:1234/cb'],
          },
          { status: 200 }
        )
      )
    })
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const res = await withFetch(upstream, () =>
      h(
        req({
          client_name: 'test',
          redirect_uris: ['http://localhost:1234/cb', 'http://127.0.0.1/cb', 'https://x.example/cb'],
        })
      )
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.client_id).toBe('abc123')
    // Default for Stalwart's missing field.
    expect(body.token_endpoint_auth_method).toBe('none')
    // Upstream got the admin Authorization header.
    expect(calls[0]?.url).toBe(`${STALWART}/auth/register`)
    const sentAuth = new Headers(calls[0]?.init?.headers as Record<string, string>).get('authorization')
    expect(sentAuth).toBe(AUTH)
  })

  test('preserves a client-supplied token_endpoint_auth_method', async () => {
    const upstream = mock(() =>
      Promise.resolve(
        Response.json(
          {
            client_id: 'abc',
            redirect_uris: ['https://x/cb'],
            token_endpoint_auth_method: 'client_secret_post',
          },
          { status: 200 }
        )
      )
    )
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const res = await withFetch(upstream, () => h(req({ redirect_uris: ['https://x/cb'] })))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.token_endpoint_auth_method).toBe('client_secret_post')
  })

  test('translates Stalwart Problem Details 401 into RFC 6749 JSON', async () => {
    const upstream = mock(() =>
      Promise.resolve(
        Response.json(
          {
            detail: 'You have to authenticate first.',
            status: 401,
            title: 'Unauthorized',
            type: 'about:blank',
          },
          {
            headers: { 'content-type': 'application/problem+json' },
            status: 401,
          }
        )
      )
    )
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const res = await withFetch(upstream, () => h(req({ redirect_uris: ['https://x/cb'] })))
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_client_metadata')
    expect(String(body.error_description)).toContain('authenticate')
  })

  test('upstream 500 maps to 502 server_error', async () => {
    const upstream = mock(() => Promise.resolve(new Response('boom', { status: 500 })))
    const h = createDcrHandler({ stalwartBase: STALWART, upstreamAuth: AUTH })
    const res = await withFetch(upstream, () => h(req({ redirect_uris: ['https://x/cb'] })))
    expect(res.status).toBe(502)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('server_error')
  })
})
