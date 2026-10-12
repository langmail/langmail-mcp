import { describe, expect, test } from 'bun:test'

import {
  byteLimit,
  createImageProxy,
  createImageProxyStore,
  isProxyableImageUrl,
  isPublicAddress,
  type ResolveHost,
} from './image-proxy.ts'

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
    t += 25 * 60 * 60 * 1000
    expect(store.lookup(token)).toBeNull()
  })

  test('reuses the token for the same URL within a mint window and refreshes its TTL', () => {
    let t = 0
    const store = createImageProxyStore(() => t)
    const a = store.mint('https://cdn.example.com/qr.png')
    t = 23 * 60 * 60 * 1000
    const b = store.mint('https://cdn.example.com/qr.png')
    expect(a).toBe(b)
    // A preview rendered at hour 23 must not ship image URLs that die at
    // hour 24 — the re-mint restarts the window.
    t = 46 * 60 * 60 * 1000
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

// 192.0.2.0/24 and 2001:db8::/32 are documentation ranges: not in the
// non-public list, and provably not anyone's real host.
const resolvesTo =
  (...addresses: string[]): ResolveHost =>
  () =>
    Promise.resolve(addresses)
const publicHost = resolvesTo('192.0.2.10')

describe('isPublicAddress', () => {
  test('accepts public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress('192.0.2.10')).toBe(true)
    expect(isPublicAddress('2001:db8::1')).toBe(true)
    // BlockList checks a mapped address against the IPv4 rules; it must not
    // over-block a public one.
    expect(isPublicAddress('::ffff:192.0.2.10')).toBe(true)
  })

  test('fails closed on a string that is not an IP literal', () => {
    expect(isPublicAddress('cdn.example.com')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
  })

  test('rejects loopback, RFC 1918, link-local, CGNAT and unspecified IPv4', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.7',
      '169.254.169.254',
      '100.100.1.1',
      '0.0.0.0',
    ]) {
      expect(isPublicAddress(address)).toBe(false)
    }
  })

  test('rejects loopback, unique-local, link-local and IPv4-embedding IPv6 addresses', () => {
    for (const address of [
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
      '::ffff:0:7f00:1',
      'fec0::1',
    ]) {
      expect(isPublicAddress(address)).toBe(false)
    }
  })
})

describe('createImageProxy', () => {
  test('404s an unknown token', async () => {
    const proxy = createImageProxy(
      createImageProxyStore(),
      upstreamOk('x', { 'content-type': 'image/png' }),
      publicHost
    )
    const res = await proxy('nope')
    expect(res.status).toBe(404)
  })

  test('streams an upstream image back with its content type', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(store, upstreamOk('PNGBYTES', { 'content-type': 'image/png' }), publicHost)
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
    const proxy = createImageProxy(
      store,
      upstreamOk('<svg onload="x()">', { 'content-type': 'image/svg+xml' }),
      publicHost
    )
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s when upstream is not an image', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(store, upstreamOk('<html>', { 'content-type': 'text/html' }), publicHost)
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s when upstream declares an oversized body', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(
      store,
      upstreamOk('x', { 'content-length': String(20 * 1024 * 1024), 'content-type': 'image/png' }),
      publicHost
    )
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s when the upstream fetch rejects', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const failing = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch
    const proxy = createImageProxy(store, failing, publicHost)
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('connects to the resolved address while presenting the original hostname', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/img/qr.png?v=2')
    const calls: Array<{ init: RequestInit & { tls?: { serverName?: string } }; url: string }> = []
    const recording = ((url: string, init: RequestInit) => {
      calls.push({ init, url })
      return Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    }) as unknown as typeof fetch
    const proxy = createImageProxy(store, recording, publicHost)
    const res = await proxy(token)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://192.0.2.10/img/qr.png?v=2')
    expect(new Headers(calls[0]?.init.headers).get('host')).toBe('cdn.example.com')
    expect(calls[0]?.init.tls?.serverName).toBe('cdn.example.com')
    expect(calls[0]?.init.redirect).toBe('error')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('brackets a pinned IPv6 address in the URL', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const urls: string[] = []
    const recording = ((url: string) => {
      urls.push(url)
      return Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    }) as unknown as typeof fetch
    const proxy = createImageProxy(store, recording, resolvesTo('2001:db8::1'))
    await proxy(token)
    expect(urls).toEqual(['https://[2001:db8::1]/qr.png'])
  })

  test('pins a dual-stack host to its IPv4 address whatever the resolver order', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const urls: string[] = []
    const recording = ((url: string) => {
      urls.push(url)
      return Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    }) as unknown as typeof fetch
    const proxy = createImageProxy(store, recording, resolvesTo('2001:db8::1', '192.0.2.10'))
    await proxy(token)
    expect(urls).toEqual(['https://192.0.2.10/qr.png'])
  })

  test('falls back to the next checked address when one does not connect', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const urls: string[] = []
    const firstDown = ((url: string) => {
      urls.push(url)
      if (url.startsWith('https://192.0.2.10/')) {
        return Promise.reject(new Error('ECONNREFUSED'))
      }
      return Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    }) as unknown as typeof fetch
    const proxy = createImageProxy(store, firstDown, resolvesTo('2001:db8::1', '192.0.2.10', '192.0.2.11'))
    const res = await proxy(token)
    expect(res.status).toBe(200)
    // IPv4 first, in resolver order; the IPv6 address is never needed.
    expect(urls).toEqual(['https://192.0.2.10/qr.png', 'https://192.0.2.11/qr.png'])
  })

  test('502s when no checked address connects', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const urls: string[] = []
    const allDown = ((url: string) => {
      urls.push(url)
      return Promise.reject(new Error('ECONNREFUSED'))
    }) as unknown as typeof fetch
    const proxy = createImageProxy(store, allDown, resolvesTo('192.0.2.10', '2001:db8::1'))
    const res = await proxy(token)
    expect(res.status).toBe(502)
    expect(urls).toEqual(['https://192.0.2.10/qr.png', 'https://[2001:db8::1]/qr.png'])
  })

  test('502s without fetching when the hostname resolves to a private address — DNS rebinding', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    let fetched = false
    const spy = (() => {
      fetched = true
      return Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    }) as unknown as typeof fetch
    for (const resolve of [resolvesTo('127.0.0.1'), resolvesTo('192.0.2.10', '10.0.0.5'), resolvesTo()]) {
      const res = await createImageProxy(store, spy, resolve)(token)
      expect(res.status).toBe(502)
    }
    expect(fetched).toBe(false)
  })

  test('502s once the deadline passes while DNS never answers', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const hanging: ResolveHost = () => new Promise(() => undefined)
    const proxy = createImageProxy(store, upstreamOk('PNG', { 'content-type': 'image/png' }), hanging, 20)
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })

  test('502s without fetching when the resolver returns a non-literal address', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    let fetched = false
    const spy = (() => {
      fetched = true
      return Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }))
    }) as unknown as typeof fetch
    const res = await createImageProxy(store, spy, resolvesTo('cdn.example.com'))(token)
    expect(res.status).toBe(502)
    expect(fetched).toBe(false)
  })

  test('502s when the hostname does not resolve', async () => {
    const store = createImageProxyStore()
    const token = store.mint('https://cdn.example.com/qr.png')
    const proxy = createImageProxy(store, upstreamOk('PNG', { 'content-type': 'image/png' }), () =>
      Promise.reject(new Error('ENOTFOUND'))
    )
    const res = await proxy(token)
    expect(res.status).toBe(502)
  })
})
