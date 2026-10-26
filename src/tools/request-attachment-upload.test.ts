import { describe, expect, test } from 'bun:test'

import { type UploadTicketInput } from '../attachments/upload-tickets.ts'
import { requestAttachmentUpload, requestAttachmentUploadInput } from './request-attachment-upload.ts'

const PUBLIC = 'https://mcp.example.com'
const EXPIRES_AT = Date.UTC(2026, 9, 26, 9, 15)

const makeDeps = () => {
  const minted: UploadTicketInput[] = []
  const resolved: string[] = []
  return {
    deps: {
      mintUploadTicket: (input: UploadTicketInput) => {
        minted.push(input)
        return { expiresAt: EXPIRES_AT, token: 'upl0ad' }
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

describe('requestAttachmentUploadInput schema', () => {
  test('requires a filename and accepts an optional type and size', () => {
    expect(requestAttachmentUploadInput.safeParse({ filename: 'a.pdf' }).success).toBe(true)
    expect(
      requestAttachmentUploadInput.safeParse({ filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }).success
    ).toBe(true)
    expect(requestAttachmentUploadInput.safeParse({ filename: '' }).success).toBe(false)
    expect(requestAttachmentUploadInput.safeParse({ filename: 'a.pdf', sizeBytes: -1 }).success).toBe(false)
    expect(
      requestAttachmentUploadInput.safeParse({ filename: 'a.pdf', mimeType: 'application/pdf\r\nx: 1' }).success
    ).toBe(false)
  })
})

describe('requestAttachmentUpload', () => {
  test('mints a ticket for the account and returns the URL, the curl command and the next step', async () => {
    const { deps, minted, resolved } = makeDeps()
    const result = await requestAttachmentUpload(deps, {
      args: { filename: 'Bescheid.pdf', sizeBytes: 2_579_206 },
      token: 'secret',
    })
    const txt = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(resolved).toEqual(['Bearer secret'])
    // The type is guessed from the extension and pinned on the ticket.
    expect(minted).toEqual([
      { accountId: 'acct', authorization: 'Bearer secret', filename: 'Bescheid.pdf', type: 'application/pdf' },
    ])
    expect(txt).toContain(`${PUBLIC}/attachments/uploads/upl0ad`)
    expect(txt).toContain(`curl -sS -T '<path to the file>' '${PUBLIC}/attachments/uploads/upl0ad'`)
    expect(txt).toContain('2026-10-26T09:15:00.000Z')
    expect(txt).toContain('{"blobId": "<blobId>", "filename": "Bescheid.pdf"}')
    expect(txt).toContain('do not show it to the user')
    expect(txt).not.toContain('secret')
  })

  test('an explicit mimeType wins over the extension', async () => {
    const { deps, minted } = makeDeps()
    await requestAttachmentUpload(deps, { args: { filename: 'scan', mimeType: 'image/tiff' }, token: 't' })
    expect(minted[0]?.type).toBe('image/tiff')
  })

  test('a file over the cap is refused before a URL is issued', async () => {
    const { deps, minted } = makeDeps()
    const result = await requestAttachmentUpload(deps, {
      args: { filename: 'huge.zip', sizeBytes: 30 * 1024 * 1024 },
      token: 't',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('25 MB')
    expect(result.content[0]?.text).toContain('no upload URL was issued')
    expect(minted).toHaveLength(0)
  })
})
