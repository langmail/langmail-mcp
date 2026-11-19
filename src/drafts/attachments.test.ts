import { describe, expect, test } from 'bun:test'

import { type BlobUploadParams } from '../jmap/index.ts'
import {
  attachmentsSchema,
  decodedByteLength,
  MAX_ATTACHMENT_BYTES,
  mimeTypeFor,
  resolveAttachments,
} from './attachments.ts'

const base64 = (value: string): string => Buffer.from(value).toString('base64')

const deps = (uploads: BlobUploadParams[] = []) => ({
  blobUpload: (p: BlobUploadParams) => {
    uploads.push(p)
    return Promise.resolve(`Gblob${uploads.length}`)
  },
})

const resolve = (entries: unknown[], uploads: BlobUploadParams[] = []) =>
  resolveAttachments(deps(uploads), {
    accountId: 'acct',
    authorization: 'Bearer tok',
    entries: attachmentsSchema.parse(entries),
  })

describe('mimeTypeFor', () => {
  test('prefers what the caller said over what the extension suggests', () => {
    expect(mimeTypeFor({ filename: 'report.pdf', mimeType: 'text/plain' })).toBe('text/plain')
  })

  test('guesses from the extension, case-insensitively', () => {
    expect(mimeTypeFor({ filename: 'RE-2026-006.PDF' })).toBe('application/pdf')
    expect(mimeTypeFor({ filename: 'chart.png' })).toBe('image/png')
  })

  test('falls back to octet-stream for an unknown or absent extension', () => {
    expect(mimeTypeFor({ filename: 'archive.tar.zst' })).toBe('application/octet-stream')
    expect(mimeTypeFor({ blobId: 'Gx' })).toBe('application/octet-stream')
  })
})

describe('decodedByteLength', () => {
  test('agrees with the decoder exactly, across every padding case', () => {
    // The cap is enforced on this number *instead of* decoding, so if it ever
    // disagreed with the decoder the ceiling would silently move. Lengths 0-3
    // mod 3 cover both padded forms and the unpadded one.
    for (const size of [0, 1, 2, 3, 4, 5, 6, 100, 1023, 1024]) {
      const encoded = Buffer.alloc(size).toString('base64')
      expect(decodedByteLength(encoded)).toBe(size)
    }
  })
})

describe('resolveAttachments', () => {
  test('re-references an existing blobId without uploading anything', async () => {
    const uploads: BlobUploadParams[] = []
    const out = await resolve([{ blobId: 'Gcontract', filename: 'contract.pdf' }], uploads)
    expect(out).toEqual({ attachments: [{ blobId: 'Gcontract', name: 'contract.pdf', type: 'application/pdf' }] })
    // The whole point of the blobId path: forwarding moves no bytes.
    expect(uploads).toEqual([])
  })

  test('uploads base64 content and attaches the returned handle', async () => {
    const uploads: BlobUploadParams[] = []
    const out = await resolve([{ content: base64('%PDF-1.4 invoice'), filename: 'invoice.pdf' }], uploads)
    expect(out).toEqual({ attachments: [{ blobId: 'Gblob1', name: 'invoice.pdf', type: 'application/pdf' }] })
    expect(uploads[0]?.type).toBe('application/pdf')
    expect(Buffer.from(uploads[0]?.content as Uint8Array).toString()).toBe('%PDF-1.4 invoice')
  })

  test('decodes base64 that arrived wrapped across lines', async () => {
    const uploads: BlobUploadParams[] = []
    const payload = base64('x'.repeat(200))
    const wrapped = `${payload.slice(0, 40)}\n${payload.slice(40)}`
    const out = await resolve([{ content: wrapped, filename: 'big.txt' }], uploads)
    expect('attachments' in out).toBe(true)
    // A model that wrapped its own output has not corrupted the file.
    expect(Buffer.from(uploads[0]?.content as Uint8Array).toString()).toBe('x'.repeat(200))
  })

  test('keeps the caller’s ordering when uploads and blobIds are mixed', async () => {
    const out = await resolve([
      { content: base64('one'), filename: 'one.txt' },
      { blobId: 'Gtwo', filename: 'two.pdf' },
      { content: base64('three'), filename: 'three.txt' },
    ])
    expect('attachments' in out && out.attachments.map((a) => a.blobId)).toEqual(['Gblob1', 'Gtwo', 'Gblob2'])
  })

  test('refuses content that is not base64, rather than attaching corrupted bytes', async () => {
    const uploads: BlobUploadParams[] = []
    const out = await resolve([{ content: 'not base64 at all!!', filename: 'invoice.pdf' }], uploads)
    expect('error' in out && out.error).toContain('not valid base64')
    // Named by filename, so the agent knows which of several files to re-encode.
    expect('error' in out && out.error).toContain('invoice.pdf')
    expect(uploads).toEqual([])
  })

  test('refuses an entry that names no file, and says a path is not one', async () => {
    // A path is stripped by the schema, so this is what the motivating "I have
    // it on disk" call actually looks like from here — the error has to redirect
    // it rather than shrug.
    const out = await resolve([{ path: '/abs/path/RE-2026-006.pdf' }])
    expect('error' in out && out.error).toContain('cannot read your filesystem')
    expect('error' in out && out.error).toContain('`content`')
  })

  test('refuses content that is only whitespace instead of staging an empty file', async () => {
    const uploads: BlobUploadParams[] = []
    // The schema's `.min(1)` passes, and the empty string left after stripping
    // is valid base64 for zero bytes — so without an explicit check this stages
    // an empty attachment and calls it a success.
    const out = await resolve([{ content: '   \n  ', filename: 'invoice.pdf' }], uploads)
    expect('error' in out && out.error).toContain('is empty')
    expect(uploads).toEqual([])
  })

  test('refuses a blobId with no filename, rather than forwarding an unnamed file', async () => {
    // The blob carries bytes only; the name lived on the message it came from.
    // Attaching it unnamed would deliver an opaque octet-stream download.
    const out = await resolve([{ blobId: 'Gcontract' }])
    expect('error' in out && out.error).toContain('`filename`')
  })

  test('refuses an entry that gives both a blobId and content', async () => {
    const out = await resolve([{ blobId: 'Gx', content: base64('bytes'), filename: 'invoice.pdf' }])
    expect('error' in out && out.error).toContain('ambiguous')
  })

  test('refuses a combined payload over the cap, naming the number, before uploading', async () => {
    const uploads: BlobUploadParams[] = []
    const half = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1).toString('base64')
    const out = await resolve(
      [
        { content: half, filename: 'a.bin' },
        { content: half, filename: 'b.bin' },
      ],
      uploads
    )
    expect('error' in out && out.error).toContain('25 MB')
    // Nothing uploaded: a rejected call leaves no orphaned blob behind.
    expect(uploads).toEqual([])
  })

  test('measures the payload exactly, so the byte on either side of the cap decides it', async () => {
    // The size is computed from the base64 length rather than by decoding (see
    // `decodedByteLength`), so this pins the arithmetic — an off-by-one in the
    // padding correction would show up here and nowhere else.
    const exact = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64')
    expect('attachments' in (await resolve([{ content: exact, filename: 'exact.bin' }]))).toBe(true)

    const oneOver = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')
    expect('error' in (await resolve([{ content: oneOver, filename: 'over.bin' }]))).toBe(true)
  })

  test('counts a blobId entry against neither the cap nor the uploads', async () => {
    const uploads: BlobUploadParams[] = []
    // The cap meters what this call uploads, not what the finished message
    // weighs — a file already on the server costs us nothing to reference, and
    // weighing it would mean a lookup per attachment on the cheap path. Stalwart
    // still refuses an undeliverable message at submission.
    const out = await resolve(
      [
        { blobId: 'Ghuge', filename: 'huge.pdf' },
        { content: base64('small'), filename: 'small.txt' },
      ],
      uploads
    )
    expect('attachments' in out).toBe(true)
    expect(uploads).toHaveLength(1)
  })

  test('resolves an empty list to no attachments', async () => {
    expect(await resolve([])).toEqual({ attachments: [] })
  })
})

describe('attachmentsSchema', () => {
  test('caps the number of files a single call can name', () => {
    expect(() => attachmentsSchema.parse(Array.from({ length: 11 }, () => ({ blobId: 'Gx' })))).toThrow()
  })
})
