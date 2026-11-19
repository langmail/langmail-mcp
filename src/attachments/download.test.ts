import { describe, expect, mock, test } from 'bun:test'

import { type JmapLive } from '../jmap/index.ts'
import { createAttachmentDownload } from './download.ts'
import { createTicketStore, type TicketInput } from './tickets.ts'

const STALWART = 'https://mail.example.com'

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

const INPUT: TicketInput = {
  accountId: 'acct',
  authorization: 'Bearer stalwart-tok',
  blobId: 'Gd41d8cd',
  name: 'invoice.pdf',
  type: 'application/pdf',
}

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

// Mint a ticket and redeem it against a stubbed upstream in one step — every
// test here goes through the real ticket store, so the token is the only
// credential the caller holds.
const redeem = (
  upstream: (url: string, init?: RequestInit) => Promise<Response>,
  input: Partial<TicketInput> = {}
): Promise<Response> => {
  const tickets = createTicketStore()
  const download = createAttachmentDownload(live, tickets)
  const token = tickets.mint({ ...INPUT, ...input })
  return withFetch(upstream, () => download(token))
}

// The ASCII fallback and the RFC 5987 form of the same name, as one string.
const disposition = async (name: string): Promise<string> => {
  const res = await redeem(() => Promise.resolve(new Response('x', { status: 200 })), { name })
  return res.headers.get('content-disposition') ?? ''
}

describe('attachment download', () => {
  test('forwards the ticket tuple upstream and streams the blob back', async () => {
    const pdf = '%PDF-1.4 fake'
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(`${STALWART}/jmap/download/acct/Gd41d8cd/invoice.pdf?accept=application%2Fpdf`)
      // The stored bearer — never a client credential — authenticates upstream.
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer stalwart-tok')
      return Promise.resolve(
        new Response(pdf, {
          headers: { 'content-length': String(pdf.length), 'content-type': 'application/pdf' },
          status: 200,
        })
      )
    })
    const res = await redeem(f)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(pdf)
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('download headers: no-store, upstream content-type, copied content-length', async () => {
    const body = 'bytes'
    const res = await redeem(() =>
      Promise.resolve(
        new Response(body, {
          headers: { 'content-length': String(body.length), 'content-type': 'application/pdf' },
          status: 200,
        })
      )
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-length')).toBe('5')
  })

  test("content-type falls back to the ticket's type when upstream omits one", async () => {
    const res = await redeem(() => Promise.resolve(new Response(new ReadableStream(), { status: 200 })), {
      type: 'image/png',
    })
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('content-length is omitted when upstream does not declare one', async () => {
    const res = await redeem(() => Promise.resolve(new Response(new ReadableStream(), { status: 200 })))
    expect(res.headers.get('content-length')).toBeNull()
  })

  test('the response resolves without waiting for the body to finish', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const upstream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
    })
    const encoder = new TextEncoder()
    controller.enqueue(encoder.encode('first '))
    // Still open: a buffering implementation could not have returned yet.
    const res = await redeem(() => Promise.resolve(new Response(upstream, { status: 200 })))
    expect(res.body).toBeInstanceOf(ReadableStream)
    controller.enqueue(encoder.encode('second'))
    controller.close()
    expect(await res.text()).toBe('first second')
  })

  test('an unknown token is a plain 404 that never touches Stalwart', async () => {
    const tickets = createTicketStore()
    const download = createAttachmentDownload(live, tickets)
    const f = mock(() => Promise.reject(new Error('must not reach upstream')))
    const res = await withFetch(f, () => download('not-a-token'))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found\n')
    expect(f).not.toHaveBeenCalled()
  })

  test('an expired ticket is indistinguishable from an unknown one', async () => {
    let now = 0
    const tickets = createTicketStore(() => now)
    const download = createAttachmentDownload(live, tickets)
    const token = tickets.mint(INPUT)
    now = 25 * 60 * 60 * 1000
    const f = mock(() => Promise.reject(new Error('must not reach upstream')))
    const res = await withFetch(f, () => download(token))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found\n')
    expect(f).not.toHaveBeenCalled()
  })

  test('an upstream status error collapses to 502 without leaking the bearer', async () => {
    const res = await redeem(() => Promise.resolve(new Response('unauthorized', { status: 401 })), {
      authorization: 'Bearer expired-secret',
    })
    // Stalwart's own status is deliberately not forwarded to the client.
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toBe('upstream error\n')
    expect(text).not.toContain('expired-secret')
  })

  test('a session lookup failure is also a 502', async () => {
    const failing: JmapLive = {
      getSession: () => Promise.reject(new Error('session resource unreachable')),
      resolveAccountId: () => Promise.resolve('acct'),
    }
    const tickets = createTicketStore()
    const download = createAttachmentDownload(failing, tickets)
    const token = tickets.mint(INPUT)
    const f = mock(() => Promise.reject(new Error('must not reach upstream')))
    const res = await withFetch(f, () => download(token))
    expect(res.status).toBe(502)
    expect(f).not.toHaveBeenCalled()
  })

  describe('content-disposition', () => {
    test('a plain ASCII name appears in both filename forms unchanged', async () => {
      expect(await disposition('invoice.pdf')).toBe(
        'attachment; filename="invoice.pdf"; filename*=UTF-8\'\'invoice.pdf'
      )
    })

    test('quotes, backslashes and control chars are stripped (no header smuggling)', async () => {
      expect(await disposition('evil"\r\nx-injected: 1.pdf')).toBe(
        'attachment; filename="evilx-injected: 1.pdf"; filename*=UTF-8\'\'evilx-injected%3A%201.pdf'
      )
      expect(await disposition('back\\slash.pdf')).toBe(
        'attachment; filename="backslash.pdf"; filename*=UTF-8\'\'backslash.pdf'
      )
    })

    test('non-Latin-1 names get an ASCII fallback plus an RFC 5987 filename*', async () => {
      // Header values are Latin-1 ByteStrings: the raw name in filename=
      // would make the Headers constructor throw and 500 the route.
      const value = await disposition('Rechnung — Büro 請求書.pdf')
      expect(value).toContain('filename="Rechnung _ B_ro ___.pdf"')
      expect(value).toContain("filename*=UTF-8''Rechnung%20%E2%80%94%20B%C3%BCro%20%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf")
    })

    test("the !'()* characters encodeURIComponent leaves bare get a second pass", async () => {
      const value = await disposition("re!port's (final)*.pdf")
      // attr-char (RFC 5987 §3.2.1) excludes them, so filename* must escape them…
      expect(value).toContain("filename*=UTF-8''re%21port%27s%20%28final%29%2A.pdf")
      // …while the quoted filename= form keeps them verbatim.
      expect(value).toContain('filename="re!port\'s (final)*.pdf"')
    })

    test('a name that strips down to nothing falls back to "attachment"', async () => {
      expect(await disposition('""')).toBe('attachment; filename="attachment"; filename*=UTF-8\'\'attachment')
      expect(await disposition('   ')).toBe('attachment; filename="attachment"; filename*=UTF-8\'\'attachment')
    })
  })
})
