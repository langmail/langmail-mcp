import { describe, expect, test } from 'bun:test'

import { type UploadTicketInput } from '../attachments/upload-tickets.ts'
import { uploadAttachments, uploadAttachmentsInput } from './upload-attachments.ts'

const PUBLIC = 'https://mcp.example.com'
const EXPIRES_AT = Date.UTC(2026, 9, 26, 9, 15)

const makeDeps = () => {
  const minted: UploadTicketInput[] = []
  const resolved: string[] = []
  return {
    deps: {
      mintUploadTicket: (input: UploadTicketInput) => {
        minted.push(input)
        return { expiresAt: EXPIRES_AT, token: `upl0ad${minted.length}` }
      },
      publicUrl: PUBLIC,
      resolveAccountId: (authorization: string) => {
        resolved.push(authorization)
        return Promise.resolve('acct')
      },
    },
    minted,
    resolved,
  }
}

describe('uploadAttachmentsInput schema', () => {
  test('takes 1 to 10 files, each with a filename and an optional type and size', () => {
    const parse = (files: unknown) => uploadAttachmentsInput.safeParse({ files }).success
    expect(parse([{ filename: 'a.pdf' }])).toBe(true)
    expect(parse([{ filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }])).toBe(true)
    expect(parse([])).toBe(false)
    expect(parse(Array.from({ length: 11 }, (_, i) => ({ filename: `${i}.pdf` })))).toBe(false)
    expect(parse([{ filename: '' }])).toBe(false)
    expect(parse([{ filename: 'a.pdf', sizeBytes: -1 }])).toBe(false)
    // The type becomes a header upstream, so nothing CR/LF-shaped gets through.
    expect(parse([{ filename: 'a.pdf', mimeType: 'application/pdf\r\nx: 1' }])).toBe(false)
  })
})

describe('uploadAttachments', () => {
  test('mints one ticket per file and returns a URL and curl command for each', async () => {
    const { deps, minted, resolved } = makeDeps()
    const result = await uploadAttachments(deps, {
      args: { files: [{ filename: 'Bescheid.pdf', sizeBytes: 2_579_206 }, { filename: 'Kontoauszug.csv' }] },
      token: 'secret',
    })
    const txt = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(resolved).toEqual(['Bearer secret'])
    // Types are guessed from the extension and pinned on each ticket.
    expect(minted).toEqual([
      { accountId: 'acct', authorization: 'Bearer secret', filename: 'Bescheid.pdf', type: 'application/pdf' },
      { accountId: 'acct', authorization: 'Bearer secret', filename: 'Kontoauszug.csv', type: 'text/csv' },
    ])
    expect(txt).toContain(`curl -sS -T '<path to Bescheid.pdf>' '${PUBLIC}/attachments/uploads/upl0ad1'`)
    expect(txt).toContain(`curl -sS -T '<path to Kontoauszug.csv>' '${PUBLIC}/attachments/uploads/upl0ad2'`)
    expect(txt).toContain('2026-10-26T09:15:00.000Z')
    expect(txt).toContain('do not show them to the user')
    expect(txt).not.toContain('secret')
  })

  test('an explicit mimeType wins over the extension', async () => {
    const { deps, minted } = makeDeps()
    await uploadAttachments(deps, { args: { files: [{ filename: 'scan', mimeType: 'image/tiff' }] }, token: 't' })
    expect(minted[0]?.type).toBe('image/tiff')
  })

  test('a quote in the filename cannot close the quoted path placeholder', async () => {
    const { deps } = makeDeps()
    const result = await uploadAttachments(deps, { args: { files: [{ filename: "it's.pdf" }] }, token: 't' })
    expect(result.content[0]?.text).toContain("'<path to its.pdf>'")
  })

  test('a file over the cap is named and skipped while the rest still get URLs', async () => {
    const { deps, minted } = makeDeps()
    const result = await uploadAttachments(deps, {
      args: {
        files: [
          { filename: 'small.pdf', sizeBytes: 10 },
          { filename: 'huge.zip', sizeBytes: 30 * 1024 * 1024 },
        ],
      },
      token: 't',
    })
    const txt = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(minted.map((m) => m.filename)).toEqual(['small.pdf'])
    expect(txt.startsWith('Upload URLs for 1 of 2 file(s)')).toBe(true)
    expect(txt).toContain("'<path to small.pdf>'")
    expect(txt).toContain('Not uploadable (1): huge.zip (30.0 MB) — over the 25 MB')
  })

  test('a batch where nothing fits is an error and mints nothing', async () => {
    const { deps, minted } = makeDeps()
    const result = await uploadAttachments(deps, {
      args: { files: [{ filename: 'huge.zip', sizeBytes: 30 * 1024 * 1024 }] },
      token: 't',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('No upload URL was issued')
    expect(minted).toHaveLength(0)
  })

  test('each file says what to attach, with the media type the blob was stored as', async () => {
    const { deps } = makeDeps()
    const result = await uploadAttachments(deps, {
      args: { files: [{ filename: 'scan', mimeType: 'image/tiff' }] },
      token: 't',
    })
    expect(result.content[0]?.text).toContain(
      'then attach: {"blobId":"<blobId>","filename":"scan","mimeType":"image/tiff"}'
    )
  })
})
