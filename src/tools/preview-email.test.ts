import { describe, expect, mock, test } from 'bun:test'

import { EMAIL_VIEWER_RESOURCE_URI, PREVIEW_META_KEY } from '../email-render/meta.ts'
import { type EmailDetailRecord } from '../jmap/index.ts'
import { type PreviewEmailDeps, previewEmail, registerPreviewEmail } from './preview-email.ts'

const PUBLIC = 'https://mcp.example.org'

const ticketEmail: EmailDetailRecord = {
  attachments: [
    {
      blobId: 'Gqr',
      cid: 'qr@mailer.example.com',
      disposition: 'inline',
      name: 'qr.png',
      partId: '3',
      size: 4200,
      type: 'image/png',
    },
  ],
  from: [{ email: 'box-office@cinema.example.com', name: 'Picture Palace' }],
  htmlBody: [{ blobId: 'Ghtml', partId: '2', size: 9000, type: 'text/html' }],
  id: 'e1',
  keywords: { $seen: true, '$type:ticket': true },
  receivedAt: '2026-07-30T18:02:11Z',
  subject: 'Your tickets for tonight',
  to: [{ email: 'user@langmail.example' }],
}

const HTML =
  '<script>evil()</script>' +
  '<table><tr><td><img src="cid:qr@mailer.example.com" alt="QR"></td></tr></table>' +
  '<img src="https://cdn.cinema.example.com/banner.png">'

const makeDeps = (email: EmailDetailRecord | undefined, html: string): PreviewEmailDeps => ({
  downloadHtmlPart: mock(() => Promise.resolve(new TextEncoder().encode(html))),
  emailGetDetail: mock(() => Promise.resolve(email ? [email] : [])),
  mintAttachmentTicket: mock(() => 'att-tok'),
  mintImageToken: mock(() => 'img-tok'),
  publicUrl: PUBLIC,
  resolveAccountId: mock(() => Promise.resolve('acct')),
})

describe('previewEmail', () => {
  test('returns model metadata in structuredContent and sanitized HTML in _meta', async () => {
    const deps = makeDeps(ticketEmail, HTML)
    const out = await previewEmail(deps, { args: { id: 'e1' }, token: 'tok' })

    expect(out.isError).toBeUndefined()
    expect(out.structuredContent).toEqual({
      // The QR is an inline cid part already rendered in the preview, not a
      // document — same exclusion format.ts applies to attachment listings.
      attachmentCount: 0,
      date: '2026-07-30T18:02:11Z',
      from: 'Picture Palace <box-office@cinema.example.com>',
      renderSource: 'html',
      subject: 'Your tickets for tonight',
      tags: ['ticket'],
    })

    const meta = out._meta as Record<string, { html: string }>
    const html = meta[PREVIEW_META_KEY]?.html ?? ''
    // Model-facing text must not carry the body; the HTML rides in _meta only.
    expect(out.content[0]?.text ?? '').not.toContain('<table')
    expect(html).not.toContain('script')
    expect(html).toContain(`src="${PUBLIC}/attachments/att-tok"`)
    expect(html).toContain(`src="${PUBLIC}/image-proxy/img-tok"`)
    expect(html).not.toContain('cdn.cinema.example.com')
  })

  test('mints the cid ticket with the part identity from the message', async () => {
    const deps = makeDeps(ticketEmail, HTML)
    await previewEmail(deps, { args: { id: 'e1' }, token: 'tok' })
    expect(deps.mintAttachmentTicket).toHaveBeenCalledWith({
      accountId: 'acct',
      authorization: 'Bearer tok',
      blobId: 'Gqr',
      name: 'qr.png',
      type: 'image/png',
    })
  })

  test('falls back to an escaped text rendering when the message has no HTML part', async () => {
    const email: EmailDetailRecord = {
      ...ticketEmail,
      attachments: [
        {
          blobId: 'Gpdf',
          disposition: 'attachment',
          name: 'invoice.pdf',
          partId: '4',
          size: 8000,
          type: 'application/pdf',
        },
      ],
      bodyValues: { '1': { value: 'Seats: A1 & A2 <balcony>' } },
      htmlBody: [],
      textBody: [{ partId: '1', type: 'text/plain' }],
    }
    const deps = makeDeps(email, '')
    const out = await previewEmail(deps, { args: { id: 'e1' }, token: 'tok' })
    const structured = out.structuredContent as { attachmentCount: number; renderSource: string }
    expect(structured.renderSource).toBe('text')
    // A genuine (non-inline) document still counts.
    expect(structured.attachmentCount).toBe(1)
    const meta = out._meta as Record<string, { html: string }>
    expect(meta[PREVIEW_META_KEY]?.html).toContain('Seats: A1 &amp; A2 &lt;balcony&gt;')
    expect(deps.downloadHtmlPart).not.toHaveBeenCalled()
  })

  test('errors when the email does not exist', async () => {
    const deps = makeDeps(undefined, '')
    const out = await previewEmail(deps, { args: { id: 'missing' }, token: 'tok' })
    expect(out.isError).toBe(true)
  })
})

describe('registerPreviewEmail', () => {
  test('registers with the viewer template linked via _meta.ui and an output schema', () => {
    const registerTool = mock(() => ({}))
    const server = { registerTool } as unknown as Parameters<typeof registerPreviewEmail>[0]
    registerPreviewEmail(server, makeDeps(ticketEmail, HTML), () => 'tok')

    expect(registerTool).toHaveBeenCalledTimes(1)
    const [name, config] = registerTool.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(name).toBe('preview_email')
    const meta = config._meta as { ui?: { resourceUri?: string } }
    expect(meta.ui?.resourceUri).toBe(EMAIL_VIEWER_RESOURCE_URI)
    expect(config.outputSchema).toBeDefined()
    expect(config.annotations).toMatchObject({ readOnlyHint: true })
    expect(String(config.description)).toContain('get_email')
  })
})
