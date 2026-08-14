import { describe, expect, test } from 'bun:test'

import { byteLimit, createImageProxy, createImageProxyStore, isProxyableImageUrl } from './image-proxy.ts'

describe('isProxyableImageUrl', () => {
  test('accepts a plain https URL with a public hostname', () => {
    expect(isProxyableImageUrl('https://cdn.example.com/qr.png')).toBe(true)
  })

  test('rejects http, non-URL strings, and non-default ports', () => {
    expect(isProxyableImageUrl('http://cdn.example.com/qr.png')).toBe(false)
    expect(isProxyableImageUrl('not a url')).toBe(false)
    expect(isProxyableImageUrl('https://cdn.example.com:8443/qr.png')).toBe(false)
  })

  test('rejects SSRF-shaped hosts: IP literals, localhost, internal suffixes', () => {
    expect(isProxyableImageUrl('https://127.0.0.1/x.png')).toBe(false)
    expect(isProxyableImageUrl('https://[::1]/x.png')).toBe(false)
    expect(isProxyableImageUrl('https://192.168.1.7/x.png')).toBe(false)
    expect(isProxyableImageUrl('https://localhost/x.png')).toBe(false)
    expect(isProxyableImageUrl('https://stalwart.internal/x.png')).toBe(false)
    expect(isProxyableImageUrl('https://printer.local/x.png')).toBe(false)
  })

  test('rejects URLs with credentials', () => {
    expect(isProxyableImageUrl('https://user:pw@cdn.example.com/x.png')).toBe(false)
  })
})

describe('imageProxyStore', () => {
  test('mint/lookup round-trips a URL until the ticket expires', () => {
    let t = 0
    const store = createImageProxyStore(() => t)
    const token = store.mint('https://cdn.example.com/qr.png')
    expect(store.lookup(token)).toBe('https://cdn.example.com/qr.png')
    t += 16 * 60 * 1000
    expect(store.lookup(token)).toBeNull()
  })

  test('reuses the token for the same URL within a mint window and refreshes its TTL', () => {
    let t = 0
    const store = createImageProxyStore(() => t)
    const a = store.mint('https://cdn.example.com/qr.png')
    t = 14 * 60 * 1000
    const b = store.mint('https://cdn.example.com/qr.png')
    expect(a).toBe(b)
    // A preview rendered at minute 14 must not ship image URLs that die at
    // minute 15 — the re-mint restarts the window.
    t = 24 * 60 * 1000
    expect(store.lookup(a)).toBe('https://cdn.example.com/qr.png')
  })
})

describe('byteLimit', () => {
  const stream = (chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(new TextEncoder().encode(c))
        }
        controller.close()
      },
    })

  test('passes a body under the limit through unchanged', async () => {
    const out = stream(['abc', 'def']).pipeThrough(byteLimit(10))
    expect(await new Response(out).text()).toBe('abcdef')
  })

  test('errors the stream once the limit is exceeded — chunked bodies cannot dodge the cap', async () => {
    const out = stream(['abc', 'defg']).pipeThrough(byteLimit(5))
    await expect(new Response(out).text()).rejects.toThrow()
  })
})

const upstreamOk = (body: string, headers: Record<string, string>): typeof fetch =>
  (() => Promise.resolve(new Response(body, { headers }))) as unknown as typeof fetch

describe('createImageProxy', () => {
  test('404s an unknown token', async () => {
    const proxy = createImageProxy(createImageProxyStore(), upstreamOk('x', { 'content-type': 'image/png' }))
    const res = await proxy('nope')
    expect(res.status).toBe(404)
  })

  test('streams an upstream image back with its content type', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(store, upstreamOk('PNGBYTES', { 'content-type': 'image/png' }))
    const res = await proxy(token)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=300')
    // Never active content on our origin, even if a browser navigates here.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(await res.text()).toBe('PNGBYTES')
  })

  test('502s an SVG upstream — the image type that executes when navigated to', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(store, upstreamOk('<svg onload="x()">', { 'content-type': 'image/svg+xml' }))
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s when upstream is not an image', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(store, upstreamOk('<html>', { 'content-type': 'text/html' }))
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s when upstream declares an oversized body', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(
      store,
      upstreamOk('x', { 'content-length': String(20 * 1024 * 1024), 'content-type': 'image/png' })
    )
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s when the upstream fetch rejects', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const failing = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch
    const proxy = createImageProxy(store, failing)
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })
})
