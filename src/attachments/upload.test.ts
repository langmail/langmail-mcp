import { describe, expect, mock, test } from 'bun:test'

import { MAX_ATTACHMENT_BYTES } from '../drafts/attachments.ts'
import { type JmapLive } from '../jmap/index.ts'
import { createAttachmentUpload } from './upload.ts'
import { createUploadTicketStore, type UploadTicketInput } from './upload-tickets.ts'

const STALWART = 'https://mail.example.com'
const PUBLIC = 'https://mcp.example.com'

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

const INPUT: UploadTicketInput = {
  accountId: 'acct',
  authorization: 'Bearer stalwart-tok',
  filename: 'Bescheid 2025.pdf',
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

const put = (body: RequestInit['body'], headers: Record<string, string> = {}): Request =>
  new Request(`${PUBLIC}/attachments/uploads/t`, { body, headers, method: 'PUT' })

const setup = () => {
  const tickets = createUploadTicketStore()
  const upload = createAttachmentUpload(live, tickets)
  const { token } = tickets.mint(INPUT)
  return { tickets, token, upload }
}

const stalwartAccepts = () =>
  mock((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ blobId: 'Gblob1' }), { status: 200 }))
  )

describe('attachment upload', () => {
  test('stores the body under the ticket bearer and pinned type, and answers with the blobId', async () => {
    const { token, upload } = setup()
    const pdf = new TextEncoder().encode('%PDF-1.7 fake')
    const f = stalwartAccepts()
    // The caller's own Content-Type is ignored — the ticket pinned the type.
    const res = await withFetch(f, () => upload(token, put(pdf, { 'content-type': 'text/html' })))
    expect(res.status).toBe(200)
    const [url, init] = f.mock.calls[0] ?? []
    expect(url).toBe(`${STALWART}/jmap/upload/acct/`)
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer stalwart-tok')
    expect(headers['content-type']).toBe('application/pdf')
    expect(new Uint8Array(init?.body as Uint8Array)).toEqual(pdf)

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      blobId: 'Gblob1',
      filename: 'Bescheid 2025.pdf',
      mimeType: 'application/pdf',
      size: pdf.byteLength,
    })
    expect(body.next).toContain('{"blobId":"Gblob1","filename":"Bescheid 2025.pdf","mimeType":"application/pdf"}')
    expect(body.next).toContain('60 minutes')
    // Never the bearer.
    expect(JSON.stringify(body)).not.toContain('stalwart-tok')
  })

  test('a body sent in several chunks is stored byte for byte', async () => {
    const { token, upload } = setup()
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9])]
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })
    const f = stalwartAccepts()
    const res = await withFetch(f, () => upload(token, put(stream)))
    expect(res.status).toBe(200)
    expect(new Uint8Array(f.mock.calls[0]?.[1]?.body as Uint8Array)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    )
  })

  test('a client that drops mid-upload gets a 400, not a server error', async () => {
    const { token, upload } = setup()
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        controller.error(new Error('connection reset'))
      },
    })
    const f = stalwartAccepts()
    const res = await withFetch(f, () => upload(token, put(stream)))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('incomplete')
    expect(body.message).toContain('now used')
    expect(f).not.toHaveBeenCalled()
  })

  test('a URL is single use', async () => {
    const { token, upload } = setup()
    const f = stalwartAccepts()
    expect((await withFetch(f, () => upload(token, put('a')))).status).toBe(200)
    const again = await withFetch(f, () => upload(token, put('a')))
    expect(again.status).toBe(404)
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('an unknown token is a 404 that names the tool to call', async () => {
    const { upload } = setup()
    const f = stalwartAccepts()
    const res = await withFetch(f, () => upload('garbage', put('a')))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { message: string }).message).toContain('upload_attachments')
    expect(f).not.toHaveBeenCalled()
  })

  test('a declared oversize body is refused without spending the ticket', async () => {
    const { tickets, token, upload } = setup()
    const f = stalwartAccepts()
    const res = await withFetch(f, () =>
      upload(token, put('a', { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }))
    )
    expect(res.status).toBe(413)
    const { message } = (await res.json()) as { message: string }
    expect(message).toContain('25 MB')
    expect(message).toContain('Retry this URL')
    expect(tickets.lookup(token)).not.toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  test('an oversize body without a Content-Length is cut off at the cap', async () => {
    const { token, upload } = setup()
    const f = stalwartAccepts()
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += chunk.byteLength
        if (sent > MAX_ATTACHMENT_BYTES + 2 * chunk.byteLength) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    })
    const res = await withFetch(f, () => upload(token, put(stream)))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { message: string }).message).toContain('now used')
    expect(f).not.toHaveBeenCalled()
  })

  test('an empty body stores nothing', async () => {
    const { token, upload } = setup()
    const f = stalwartAccepts()
    const res = await withFetch(f, () => upload(token, put(null)))
    expect(res.status).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })

  test('a Stalwart refusal is a 502 that says nothing was stored', async () => {
    const { token, upload } = setup()
    const f = mock(() => Promise.resolve(new Response('quota', { status: 429 })))
    const res = await withFetch(f, () => upload(token, put('a')))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { message: string }).message).toContain('nothing was stored')
  })
})
