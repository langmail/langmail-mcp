import { describe, expect, mock, test } from 'bun:test'

import { blobDownload, blobDownloadUrl, blobUpload } from './blob.ts'
import { JmapError } from './session.ts'

const TEMPLATE = 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}'

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

describe('blobDownloadUrl', () => {
  test('expands every template placeholder with its value', () => {
    const url = blobDownloadUrl(TEMPLATE, {
      accountId: 'acct',
      blobId: 'Gd41d8cd',
      name: 'invoice.pdf',
      type: 'application/pdf',
    })
    expect(url).toBe('https://mail.example.com/jmap/download/acct/Gd41d8cd/invoice.pdf?accept=application%2Fpdf')
  })

  test('URI-encodes names with spaces, slashes, and unicode', () => {
    const url = blobDownloadUrl(TEMPLATE, {
      accountId: 'acct',
      blobId: 'b1',
      name: 'Rechnung Nr. 42/2026 — Büro.pdf',
      type: 'application/pdf',
    })
    expect(url).toContain('/Rechnung%20Nr.%2042%2F2026%20%E2%80%94%20B%C3%BCro.pdf?')
    // The raw slash in the name must never open a new path segment.
    expect(url).not.toContain('42/2026')
  })

  test('encodes the media type into {type}', () => {
    const url = blobDownloadUrl(TEMPLATE, { accountId: 'a', blobId: 'b', name: 'x.png', type: 'image/png' })
    expect(url.endsWith('accept=image%2Fpng')).toBe(true)
  })
})

describe('blobDownload', () => {
  test('fetches the expanded URL with the Authorization header and returns the streamed response', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe('https://mail.example.com/jmap/download/acct/b1/x.pdf?accept=application%2Fpdf')
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer tok')
      return Promise.resolve(new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' }, status: 200 }))
    })
    const res = await withFetch(f, () =>
      blobDownload({
        accountId: 'acct',
        authorization: 'Bearer tok',
        blobId: 'b1',
        downloadUrl: TEMPLATE,
        name: 'x.pdf',
        type: 'application/pdf',
      })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('%PDF-1.4')
  })

  test('throws JmapError on non-200', async () => {
    const f = mock(() => Promise.resolve(new Response('nope', { status: 404 })))
    await withFetch(f, async () => {
      const err = await blobDownload({
        accountId: 'acct',
        authorization: 'Bearer tok',
        blobId: 'missing',
        downloadUrl: TEMPLATE,
        name: 'x.pdf',
        type: 'application/pdf',
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).status).toBe(404)
    })
  })
})

const UPLOAD_TEMPLATE = 'https://mail.example.com/jmap/upload/{accountId}/'

describe('blobUpload', () => {
  test('POSTs the content to the expanded upload URL with the declared media type', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe('https://mail.example.com/jmap/upload/acct/')
      expect(init?.method).toBe('POST')
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer tok')
      expect(headers['content-type']).toBe('application/sieve')
      expect(init?.body).toBe('require ["fileinto"];')
      return Promise.resolve(Response.json({ accountId: 'acct', blobId: 'blob-7', size: 21 }, { status: 200 }))
    })
    const blobId = await withFetch(f, () =>
      blobUpload({
        accountId: 'acct',
        authorization: 'Bearer tok',
        content: 'require ["fileinto"];',
        type: 'application/sieve',
        uploadUrl: UPLOAD_TEMPLATE,
      })
    )
    expect(blobId).toBe('blob-7')
  })

  test('throws JmapError on a non-2xx upload', async () => {
    const f = mock(() => Promise.resolve(new Response('too big', { status: 413 })))
    await withFetch(f, async () => {
      const err = await blobUpload({
        accountId: 'acct',
        authorization: 'Bearer tok',
        content: 'x',
        type: 'application/sieve',
        uploadUrl: UPLOAD_TEMPLATE,
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).status).toBe(413)
    })
  })

  test('throws JmapError when the response lacks a blobId', async () => {
    const f = mock(() => Promise.resolve(Response.json({ accountId: 'acct' }, { status: 200 })))
    await withFetch(f, async () => {
      const err = await blobUpload({
        accountId: 'acct',
        authorization: 'Bearer tok',
        content: 'x',
        type: 'application/sieve',
        uploadUrl: UPLOAD_TEMPLATE,
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).message).toContain('malformed')
    })
  })
})
