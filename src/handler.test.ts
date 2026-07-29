import { describe, expect, mock, test } from 'bun:test'

import { type JmapLive } from '@langmail/jmap'

import { createAttachmentDownload } from './attachments/download.ts'
import { createTicketStore } from './attachments/tickets.ts'
import { TokenCache } from './auth/token-cache.ts'
import { createRoutes } from './handler.ts'

const STALWART = 'https://mail.example.com'
const AUTH = 'https://auth.example.com/api/auth'
const PUBLIC = 'https://mcp.example.com'

const makeRoutes = (opts: { cache?: TokenCache } = {}) =>
  createRoutes({
    authIssuer: AUTH,
    cache: opts.cache,
    // Pinned so the assertion doesn't depend on the runner's environment.
    observability: () => ({ errorTracking: true, logShipping: true }),
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

  test('GET /readyz reports whether log shipping and error tracking are configured', async () => {
    // Presence booleans, never values — the uptime monitor records these with
    // every check, so a reboot that emptied /run/secrets is visible from the
    // incident body rather than needing a VM login.
    const r = makeRoutes()
    const res = await withFetch(
      () => Promise.resolve(new Response(null, { status: 401 })),
      () => r.fetch(new Request(`${PUBLIC}/readyz`))
    )
    const body = (await res.json()) as { observability: Record<string, boolean> }
    expect(body.observability).toEqual({ errorTracking: true, logShipping: true })
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

describe('GET /attachments/:token', () => {
  const live: JmapLive = {
    getSession: () =>
      Promise.resolve({
        apiUrl: `${STALWART}/jmap/`,
        downloadUrl: `${STALWART}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct' },
        uploadUrl: `${STALWART}/jmap/upload/{accountId}/`,
      }),
    resolveAccountId: () => Promise.resolve('acct'),
  }

  const makeAttachmentRoutes = () => {
    const tickets = createTicketStore()
    const routes = createRoutes({
      attachmentDownload: createAttachmentDownload(live, tickets),
      authIssuer: AUTH,
      publicUrl: PUBLIC,
      stalwartUrl: STALWART,
    })
    return { routes, tickets }
  }

  test('streams the Stalwart blob through with download headers, no bearer required', async () => {
    const { routes, tickets } = makeAttachmentRoutes()
    const token = tickets.mint({
      accountId: 'acct',
      authorization: 'Bearer stalwart-tok',
      blobId: 'Gd41d8cd',
      name: 'invoice.pdf',
      type: 'application/pdf',
    })
    const pdf = '%PDF-1.4 fake'
    const f = mock((url: string, init?: RequestInit) => {
      // The stored bearer (not any client credential) is forwarded upstream.
      expect(url).toBe(`${STALWART}/jmap/download/acct/Gd41d8cd/invoice.pdf?accept=application%2Fpdf`)
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer stalwart-tok')
      return Promise.resolve(
        new Response(pdf, {
          headers: { 'content-length': String(pdf.length), 'content-type': 'application/pdf' },
          status: 200,
        })
      )
    })
    const res = await withFetch(f, () => routes.fetch(new Request(`${PUBLIC}/attachments/${token}`)))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="invoice.pdf"; filename*=UTF-8\'\'invoice.pdf'
    )
    expect(res.headers.get('content-length')).toBe(String(pdf.length))
    expect(await res.text()).toBe(pdf)
  })

  test('sanitizes hostile filenames in content-disposition', async () => {
    const { routes, tickets } = makeAttachmentRoutes()
    const token = tickets.mint({
      accountId: 'acct',
      authorization: 'Bearer t',
      blobId: 'b1',
      name: 'evil"\r\nx-injected: 1.pdf',
      type: 'application/pdf',
    })
    const f = mock(() => Promise.resolve(new Response('x', { status: 200 })))
    const res = await withFetch(f, () => routes.fetch(new Request(`${PUBLIC}/attachments/${token}`)))
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="evilx-injected: 1.pdf"; filename*=UTF-8\'\'evilx-injected%3A%201.pdf'
    )
  })

  test('non-Latin-1 filenames get an ASCII fallback plus RFC 5987 filename* (no 500)', async () => {
    const { routes, tickets } = makeAttachmentRoutes()
    const token = tickets.mint({
      accountId: 'acct',
      authorization: 'Bearer t',
      blobId: 'b1',
      // Em dash + umlaut + CJK — fetch header values are Latin-1 ByteStrings,
      // so the raw name in filename= would make the Headers constructor throw.
      name: 'Rechnung — Büro 請求書.pdf',
      type: 'application/pdf',
    })
    const f = mock(() => Promise.resolve(new Response('x', { status: 200 })))
    const res = await withFetch(f, () => routes.fetch(new Request(`${PUBLIC}/attachments/${token}`)))
    expect(res.status).toBe(200)
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('filename="Rechnung _ B_ro ___.pdf"')
    expect(disposition).toContain("filename*=UTF-8''Rechnung%20%E2%80%94%20B%C3%BCro%20%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf")
  })

  test('unknown or tampered tokens return a plain 404 without touching Stalwart', async () => {
    const { routes } = makeAttachmentRoutes()
    const f = mock(() => {
      throw new Error('must not reach upstream')
    })
    const res = await withFetch(f, () => routes.fetch(new Request(`${PUBLIC}/attachments/garbage`)))
    expect(res.status).toBe(404)
    expect(f).not.toHaveBeenCalled()
  })

  test('non-GET methods and nested paths are 404', async () => {
    const { routes, tickets } = makeAttachmentRoutes()
    const token = tickets.mint({
      accountId: 'acct',
      authorization: 'Bearer t',
      blobId: 'b1',
      name: 'x.pdf',
      type: 'application/pdf',
    })
    expect((await routes.fetch(new Request(`${PUBLIC}/attachments/${token}`, { method: 'POST' }))).status).toBe(404)
    expect((await routes.fetch(new Request(`${PUBLIC}/attachments/${token}/extra`))).status).toBe(404)
    expect((await routes.fetch(new Request(`${PUBLIC}/attachments/`))).status).toBe(404)
  })

  test('an upstream failure surfaces as 502, never the bearer', async () => {
    const { routes, tickets } = makeAttachmentRoutes()
    const token = tickets.mint({
      accountId: 'acct',
      authorization: 'Bearer expired',
      blobId: 'b1',
      name: 'x.pdf',
      type: 'application/pdf',
    })
    const f = mock(() => Promise.resolve(new Response('unauthorized', { status: 401 })))
    const res = await withFetch(f, () => routes.fetch(new Request(`${PUBLIC}/attachments/${token}`)))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('expired')
  })
})
