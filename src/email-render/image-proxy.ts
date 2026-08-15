// Image proxy for the email-viewer: remote images referenced by an email's
// HTML are fetched by this server and streamed to the iframe, so the
// client never contacts the sender's (tracking) domains — the same privacy
// stance the rest of the product takes.
//
// Same capability-URL model as /attachments/:token (ADR 0007): preview_email
// mints an unguessable token per remote URL; GET /image-proxy/:token redeems
// it. In-memory state is fine — one container, and a restart only breaks
// image URLs inside an already-rendered preview until the tool is re-called.
//
// The upstream URL is sender-controlled, so this is an SSRF surface:
// `isProxyableImageUrl` gates what gets minted (https, default port, public
// hostname shape, no credentials), redirects are refused rather than
// followed, and the response must be a raster image type within a byte cap
// enforced on the actual stream, not the declared length.

import { logger } from '@langmail/logger'

// A day, not minutes: these URLs are embedded in a rendered preview the user
// re-opens from conversation scrollback — a short TTL turns every image into
// a broken icon an hour later. The store is in-memory, so a redeploy still
// invalidates everything; that residual gap needs signed stateless URLs.
const IMAGE_PROXY_TTL_HOURS = 24
const TTL_MS = IMAGE_PROXY_TTL_HOURS * 60 * 60 * 1000

// Big enough for any real inline/hero image; a 4K photo attachment is not
// what an email body embeds.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const FETCH_TIMEOUT_MS = 10_000

// Hostname shapes that smell like an internal target rather than a public
// image host. Not a full SSRF defense (no DNS resolution check), but it
// removes the obvious ways an email could point this proxy at loopback,
// RFC 1918 space, or service-discovery names.
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const INTERNAL_SUFFIXES = ['.internal', '.local', '.localdomain']

export const isProxyableImageUrl = (raw: string): boolean => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || IP_LITERAL_RE.test(host) || host.startsWith('[')) {
    return false
  }
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return false
  }
  return true
}

export interface ImageProxyStore {
  // The upstream URL, or null when unknown/expired (indistinguishable).
  lookup: (token: string) => string | null
  // Minted token (base64url, 256-bit). The same URL re-mints to the same
  // token while unexpired, so an email with a repeated logo yields one entry.
  mint: (url: string) => string
}

const mintToken = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export const createImageProxyStore = (now: () => number = Date.now): ImageProxyStore => {
  const byToken = new Map<string, { expiresAt: number; url: string }>()
  const byUrl = new Map<string, string>()

  // Lazy sweep on mint/lookup keeps both maps bounded without a timer.
  const sweep = (): void => {
    const t = now()
    for (const [token, entry] of byToken) {
      if (entry.expiresAt <= t) {
        byToken.delete(token)
        byUrl.delete(entry.url)
      }
    }
  }

  return {
    lookup: (token) => {
      sweep()
      return byToken.get(token)?.url ?? null
    },
    mint: (url) => {
      sweep()
      const existing = byUrl.get(url)
      if (existing) {
        // Restart the window: the preview minted just now must not ship
        // image URLs that inherit a nearly-spent TTL from an earlier one.
        const entry = byToken.get(existing)
        if (entry) {
          entry.expiresAt = now() + TTL_MS
        }
        return existing
      }
      const token = mintToken()
      byToken.set(token, { expiresAt: now() + TTL_MS, url })
      byUrl.set(url, token)
      return token
    },
  }
}

export type ImageProxy = (token: string) => Promise<Response>

const notFound = (): Response => new Response('not found\n', { status: 404 })
const upstreamError = (): Response => new Response('upstream error\n', { status: 502 })

// Raster types only. image/svg+xml deliberately fails this check: it is the
// one image subtype that executes script when a browser navigates to it
// directly, and this proxy serves from our origin.
const RASTER_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])

const isRasterImageType = (contentType: string): boolean => {
  const bare = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  return RASTER_TYPES.has(bare)
}

// Enforce the size cap on the actual bytes, not the declared content-length —
// a chunked response (no length header) must not stream unbounded. Exceeding
// the limit errors the stream, which truncates the response mid-flight.
export const byteLimit = (maxBytes: number): TransformStream<Uint8Array, Uint8Array> => {
  let seen = 0
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > maxBytes) {
        controller.error(new Error('image proxy byte limit exceeded'))
        return
      }
      controller.enqueue(chunk)
    },
  })
}

export const createImageProxy = (store: ImageProxyStore, fetchImpl: typeof fetch = fetch): ImageProxy => {
  return async (token) => {
    const url = store.lookup(token)
    if (!url) {
      return notFound()
    }
    let upstream: Response
    try {
      // redirect: 'error' — a redirect could bounce to a host the mint-time
      // check never saw, so it is refused instead of followed.
      upstream = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch {
      // Log carries no URL: the target embeds sender infrastructure and the
      // occasional tracking id (REVIEW.md: no request bodies/PII in logs).
      logger.warn({ status: null }, 'image proxy upstream fetch failed')
      return upstreamError()
    }
    const type = upstream.headers.get('content-type') ?? ''
    // The declared length is a fast reject; byteLimit below enforces the cap
    // on the real bytes for chunked/lying upstreams.
    const length = Number(upstream.headers.get('content-length') ?? '0')
    if (!(upstream.ok && isRasterImageType(type)) || length > MAX_IMAGE_BYTES) {
      logger.warn({ status: upstream.status }, 'image proxy upstream not a usable image')
      return upstreamError()
    }
    const headers = new Headers({
      'cache-control': 'private, max-age=300',
      // Belt and braces against active content on our origin: no sniffing
      // away from the raster type, and a sandbox with no capabilities if a
      // browser ever navigates to this URL directly.
      'content-security-policy': "sandbox; default-src 'none'",
      'content-type': type,
      'x-content-type-options': 'nosniff',
    })
    // No content-length forwarded: fetch transparently decompresses a
    // gzip/brotli-encoded upstream, so the header would describe the encoded
    // bytes and make browsers truncate the image. Chunked streaming is fine.
    // Streamed through, never buffered.
    return new Response(upstream.body?.pipeThrough(byteLimit(MAX_IMAGE_BYTES)) ?? null, { headers })
  }
}
