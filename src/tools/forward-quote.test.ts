import { describe, expect, test } from 'bun:test'

import { type EmailComposeRecord } from '@langmail/jmap'

import { receivedMessage } from './draft-test-fixtures.ts'
import { FORWARD_MARKER, forwardDraft, forwardedBody, forwardReferences, forwardSubject } from './forward-quote.ts'

const invoice = (overrides: Partial<EmailComposeRecord> = {}): EmailComposeRecord =>
  receivedMessage({
    attachments: [
      { blobId: 'bPdf', disposition: 'attachment', name: 'invoice.pdf', size: 1200, type: 'application/pdf' },
      { blobId: 'bLogo', cid: 'logo@x', disposition: 'inline', name: 'logo.png', type: 'image/png' },
    ],
    blobId: 'bRaw',
    bodyValues: {
      h: { value: '<p>Rent for <b>March</b></p><img src="cid:logo@x"><script>alert(1)</script>' },
      t: { value: 'Rent for March' },
    },
    from: [{ email: 'landlord@example.org', name: 'Ola Landlord' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
    references: ['older@example.org'],
    sentAt: '2026-03-01T09:30:00Z',
    subject: 'Invoice March',
    textBody: [{ partId: 't', type: 'text/plain' }],
    ...overrides,
  })

describe('forwardSubject', () => {
  test('prefixes Fwd: once', () => {
    expect(forwardSubject('Invoice')).toBe('Fwd: Invoice')
    expect(forwardSubject('Fwd: Invoice')).toBe('Fwd: Invoice')
    expect(forwardSubject('FW: Invoice')).toBe('FW: Invoice')
    expect(forwardSubject('')).toBe('Fwd:')
  })
})

describe('forwardReferences', () => {
  test('is the original references plus its Message-ID', () => {
    expect(forwardReferences(invoice())).toEqual(['older@example.org', 'orig@example.org'])
  })
})

describe('forwardedBody', () => {
  test('puts the note on top and the real headers in the block, in both parts', () => {
    const body = forwardedBody({ text: 'for the tax return' }, invoice())
    expect(body.text.startsWith('for the tax return\n\n')).toBe(true)
    expect(body.text).toContain(FORWARD_MARKER)
    expect(body.text).toContain('From: Ola Landlord <landlord@example.org>')
    expect(body.text).toContain('Date: Sun, 1 Mar 2026 at 09:30 UTC')
    expect(body.text).toContain('Subject: Invoice March')
    expect(body.text).toContain('To: user@langmail.me, tomas@example.com')
    expect(body.text).toContain('Cc: carl@example.org')
    expect(body.text).toContain('Rent for March')
    expect(body.html.startsWith('for the tax return')).toBe(true)
    expect(body.html).toContain('From: Ola Landlord &lt;landlord@example.org&gt;')
    expect(body.html).toContain('<b>March</b>')
    expect(body.attachOriginal).toBe(false)
  })

  test('keeps cid images for the inline parts it carries, and drops scripts', () => {
    const { html } = forwardedBody({}, invoice())
    expect(html).toContain('src="cid:logo@x"')
    expect(html).not.toContain('<script')
  })

  test('builds both parts from a text-only original and an html-only note', () => {
    const original = invoice({ bodyValues: { t: { value: 'Plain <rent>' } }, htmlBody: [] })
    const body = forwardedBody({ html: '<p>see below</p>' }, original)
    expect(body.text.startsWith('see below')).toBe(true)
    expect(body.html).toContain('Plain &lt;rent&gt;')
    expect(body.text).toContain('Plain <rent>')
  })

  test('with no note the block comes first', () => {
    expect(forwardedBody({}, invoice()).text.startsWith(FORWARD_MARKER)).toBe(true)
  })

  test('asks for the whole original as a file when the read was truncated', () => {
    const original = invoice({
      bodyValues: { h: { isTruncated: true, value: '<p>Rent</p>' }, t: { isTruncated: true, value: 'Rent' } },
    })
    const body = forwardedBody({}, original)
    expect(body.attachOriginal).toBe(true)
    expect(body.text).toContain('the full message is attached')
  })

  test('asks for the whole original as a file when the body does not fit the part', () => {
    const long = 'x'.repeat(120_000)
    const body = forwardedBody({}, invoice({ bodyValues: { h: { value: long }, t: { value: long } } }))
    expect(body.attachOriginal).toBe(true)
    expect(body.text.length).toBeLessThanOrEqual(100_000)
  })

  test('inlines a body up to the part budget without attaching it', () => {
    const long = 'y'.repeat(60_000)
    expect(forwardedBody({}, invoice({ bodyValues: { t: { value: long } }, htmlBody: [] })).attachOriginal).toBe(false)
  })
})

describe('forwardDraft', () => {
  const from = [{ email: 'user@langmail.me' }]
  const to = [{ email: 'accountant@example.com' }]

  test('carries every file by blobId with Fwd: subject and references, recipients from the caller only', () => {
    const built = forwardDraft({
      from,
      missingFiles: 'refuse',
      note: { text: 'fyi' },
      original: invoice(),
      recipients: { to },
    })
    if ('error' in built) {
      throw new Error(built.error)
    }
    expect(built.draft.to).toEqual(to)
    expect(built.draft.cc).toBeUndefined()
    expect(built.draft.subject).toBe('Fwd: Invoice March')
    expect(built.draft.references).toEqual(['older@example.org', 'orig@example.org'])
    expect(built.draft.inReplyTo).toBeUndefined()
    expect(built.draft.attachments).toEqual([
      { blobId: 'bPdf', disposition: 'attachment', name: 'invoice.pdf', size: 1200, type: 'application/pdf' },
      { blobId: 'bLogo', cid: 'logo@x', disposition: 'inline', name: 'logo.png', type: 'image/png' },
    ])
    expect(built.note).toBeNull()
  })

  test('carries an inline image that sits among the body parts', () => {
    const original = invoice({
      attachments: [],
      textBody: [
        { partId: 't', type: 'text/plain' },
        { blobId: 'bPhoto', cid: 'photo@x', name: 'photo.jpg', type: 'image/jpeg' },
      ],
    })
    const built = forwardDraft({ from, missingFiles: 'refuse', note: {}, original, recipients: { to } })
    if ('error' in built) {
      throw new Error(built.error)
    }
    expect(built.draft.attachments).toEqual([
      { blobId: 'bPhoto', cid: 'photo@x', disposition: 'inline', name: 'photo.jpg', type: 'image/jpeg' },
    ])
  })

  test('attaches the raw original as message/rfc822 when it did not fit', () => {
    const long = 'z'.repeat(120_000)
    const built = forwardDraft({
      from,
      missingFiles: 'refuse',
      note: {},
      original: invoice({ bodyValues: { h: { value: long }, t: { value: long } } }),
      recipients: { to },
    })
    if ('error' in built) {
      throw new Error(built.error)
    }
    expect(built.note).toContain('.eml')
    expect(built.draft.attachments?.at(-1)).toEqual({
      blobId: 'bRaw',
      disposition: 'attachment',
      name: 'Invoice March.eml',
      type: 'message/rfc822',
    })
  })

  test('refuses an original whose file has no blobId', () => {
    const built = forwardDraft({
      from,
      missingFiles: 'refuse',
      note: {},
      original: invoice({ attachments: [{ name: 'odd.bin', type: 'application/octet-stream' }] }),
      recipients: { to },
    })
    expect('error' in built && built.error).toContain('odd.bin')
  })
})

describe('forwardDraft for a staged forward', () => {
  test('attaches the whole original when one of its files has no blobId, and says so', () => {
    const built = forwardDraft({
      from: [{ email: 'user@langmail.me' }],
      missingFiles: 'attachOriginal',
      note: {},
      original: invoice({ attachments: [{ name: 'odd.bin', type: 'application/octet-stream' }] }),
      recipients: { to: [{ email: 'accountant@example.com' }] },
    })
    if ('error' in built) {
      throw new Error(built.error)
    }
    expect(built.draft.attachments?.map((file) => file.type)).toEqual(['message/rfc822'])
    expect(built.note).toContain('odd.bin')
  })

  test('the shortened note is in both parts when only one was cut', () => {
    const body = forwardedBody(
      {},
      invoice({ bodyValues: { h: { value: 'h'.repeat(150_000) }, t: { value: 'short' } } })
    )
    expect(body.attachOriginal).toBe(true)
    expect(body.text).toContain('the full message is attached')
    expect(body.html).toContain('the full message is attached')
  })
})
