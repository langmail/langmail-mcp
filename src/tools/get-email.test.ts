import { describe, expect, test } from 'bun:test'

import { type EmailDetailRecord } from '@langmail/jmap'

import { getEmail, getEmailInput, type RawMessageParams } from './get-email.ts'

// Fixtures without a blobId never hit the raw-message path, so the default
// stub rejecting is only reachable from tests that opt into a blobId.
const deps = (emails: EmailDetailRecord[], downloadRawMessage?: (p: RawMessageParams) => Promise<Uint8Array>) => ({
  downloadRawMessage: downloadRawMessage ?? (() => Promise.reject(new Error('unexpected raw download'))),
  emailGetDetail: () => Promise.resolve(emails),
  resolveAccountId: () => Promise.resolve('acct'),
})

// A minimal HTML-only raw message (the Mistral/Supabase shape: one big
// inline-CSS table and no text/plain alternative).
const htmlInvoiceEml = (): Uint8Array =>
  new TextEncoder().encode(
    [
      'From: Billing <billing@vendor.example>',
      'To: Sam <sam@langmail.me>',
      'Subject: Your invoice',
      'Date: Wed, 01 Jul 2026 09:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><table style="border-collapse:collapse;font-family:Arial">',
      '<tr><td style="padding:8px">Invoice number</td><td>INV-2026-0642</td></tr>',
      '<tr><td style="padding:8px"><b>Amount due</b></td><td><b>&euro;41.27</b></td></tr>',
      '</table></body></html>',
    ].join('\r\n')
  )

describe('getEmailInput schema', () => {
  test('requires a non-empty id', () => {
    expect(getEmailInput.safeParse({ id: '' }).success).toBe(false)
    expect(getEmailInput.safeParse({}).success).toBe(false)
    expect(getEmailInput.safeParse({ id: 'e1' }).success).toBe(true)
  })
})

describe('getEmail', () => {
  test('renders subject, recipients, tags, and the text body', async () => {
    const result = await getEmail(
      deps([
        {
          bodyValues: { '1': { value: 'Hello there,\nthis is the body.' } },
          cc: [{ email: 'cc@x' }],
          from: [{ email: 'alice@x', name: 'Alice' }],
          id: 'e1',
          keywords: { '$label:receipt': true, $seen: true },
          receivedAt: '2026-05-01T00:00:00Z',
          subject: 'Invoice #42',
          textBody: [{ partId: '1', type: 'text/plain' }],
          to: [{ email: 'bob@x', name: 'Bob' }],
        },
      ]),
      { args: { id: 'e1' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Subject: Invoice #42')
    expect(txt).toContain('From: Alice <alice@x>')
    expect(txt).toContain('To: Bob <bob@x>')
    expect(txt).toContain('Cc: cc@x')
    expect(txt).toContain('Tags: receipt')
    expect(txt).toContain('this is the body.')
  })

  test('concatenates multiple text parts in order', async () => {
    const result = await getEmail(
      deps([
        {
          bodyValues: { a: { value: 'part one' }, b: { value: 'part two' } },
          id: 'e1',
          subject: 'Multi',
          textBody: [
            { partId: 'a', type: 'text/plain' },
            { partId: 'b', type: 'text/plain' },
          ],
        },
      ]),
      { args: { id: 'e1' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('part one\npart two')
  })

  test('falls back gracefully when there is no text body', async () => {
    const result = await getEmail(deps([{ id: 'e1', subject: 'Empty', textBody: [] }]), {
      args: { id: 'e1' },
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('(no text body)')
  })

  test('renders an HTML-only message as clean markdown via the raw-message pipeline', async () => {
    const seen: RawMessageParams[] = []
    const result = await getEmail(
      deps(
        [
          {
            blobId: 'Graw1',
            bodyValues: { '1': { value: '<html><table>raw html fallback</table></html>' } },
            id: 'e1',
            size: 4096,
            subject: 'Your invoice',
            textBody: [{ partId: '1', type: 'text/html' }],
          },
        ],
        (p) => {
          seen.push(p)
          return Promise.resolve(htmlInvoiceEml())
        }
      ),
      { args: { id: 'e1' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(seen).toEqual([{ accountId: 'acct', authorization: 'Bearer tok', blobId: 'Graw1' }])
    // Key figures survive as readable text; the inline-CSS table markup does not.
    expect(txt).toContain('INV-2026-0642')
    expect(txt).toContain('**Amount due**')
    expect(txt).toContain('€41.27')
    expect(txt).not.toContain('<table')
    expect(txt).not.toContain('border-collapse')
  })

  test('preserves quoted replies and signatures in the cleaned body', async () => {
    const eml = new TextEncoder().encode(
      [
        'From: Bob <bob@x.com>',
        'To: Alice <alice@x.com>',
        'Subject: Re: Meeting',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Sounds good, see you at 3pm.',
        '',
        'On Tue, Jun 30, 2026 at 5:12 PM Alice <alice@x.com> wrote:',
        '> Can we meet tomorrow afternoon?',
        '',
        '-- ',
        'Bob Miller',
      ].join('\r\n')
    )
    const result = await getEmail(
      deps([{ blobId: 'Graw1', id: 'e1', size: 512, subject: 'Re: Meeting' }], () => Promise.resolve(eml)),
      { args: { id: 'e1' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('see you at 3pm')
    expect(txt).toContain('> Can we meet tomorrow afternoon?')
    expect(txt).toContain('Bob Miller')
  })

  test('falls back to the jmap text body when the raw download fails', async () => {
    const result = await getEmail(
      deps(
        [
          {
            blobId: 'Graw1',
            bodyValues: { '1': { value: 'jmap fallback body' } },
            id: 'e1',
            size: 4096,
            subject: 'Flaky',
            textBody: [{ partId: '1', type: 'text/plain' }],
          },
        ],
        () => Promise.reject(new Error('blob 502'))
      ),
      { args: { id: 'e1' }, token: 'tok' }
    )
    expect(result.content[0]?.text ?? '').toContain('jmap fallback body')
  })

  test('skips the raw download for oversized messages and uses the jmap text body', async () => {
    let called = 0
    const result = await getEmail(
      deps(
        [
          {
            blobId: 'Graw1',
            bodyValues: { '1': { value: 'small text body' } },
            id: 'e1',
            size: 50_000_000,
            subject: 'Huge attachment',
            textBody: [{ partId: '1', type: 'text/plain' }],
          },
        ],
        () => {
          called += 1
          return Promise.resolve(htmlInvoiceEml())
        }
      ),
      { args: { id: 'e1' }, token: 'tok' }
    )
    expect(called).toBe(0)
    expect(result.content[0]?.text ?? '').toContain('small text body')
  })

  test('treats a missing size as oversized and skips the raw download', async () => {
    let called = 0
    const result = await getEmail(
      deps(
        [
          {
            blobId: 'Graw1',
            bodyValues: { '1': { value: 'small text body' } },
            id: 'e1',
            subject: 'No size',
            textBody: [{ partId: '1', type: 'text/plain' }],
          },
        ],
        () => {
          called += 1
          return Promise.resolve(htmlInvoiceEml())
        }
      ),
      { args: { id: 'e1' }, token: 'tok' }
    )
    expect(called).toBe(0)
    expect(result.content[0]?.text ?? '').toContain('small text body')
  })

  test('returns an error result when the id is not found', async () => {
    const result = await getEmail(deps([]), { args: { id: 'missing' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('missing')
  })

  test('lists attachments with name, type, human size, and blobId', async () => {
    const result = await getEmail(
      deps([
        {
          attachments: [
            {
              blobId: 'Gd41d8cd',
              disposition: 'attachment',
              name: 'invoice-2026-06.pdf',
              partId: '2',
              size: 186_778,
              type: 'application/pdf',
            },
            {
              blobId: 'G98f00b2',
              cid: 'logo@corp',
              disposition: 'inline',
              name: 'logo.png',
              partId: '3',
              size: 3174,
              type: 'image/png',
            },
          ],
          bodyValues: { '1': { value: 'see attached' } },
          id: 'e1',
          subject: 'Invoice',
          textBody: [{ partId: '1', type: 'text/plain' }],
        },
      ]),
      { args: { id: 'e1' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('Attachments (2):')
    expect(txt).toContain('1. invoice-2026-06.pdf — application/pdf, 182.4 KB — blobId: Gd41d8cd')
    // cid-referenced inline parts (logos, pixels) carry the inline marker...
    expect(txt).toContain('2. logo.png — image/png, 3.1 KB — inline — blobId: G98f00b2')
    // ...and genuine documents don't.
    expect(txt).not.toContain('invoice-2026-06.pdf — application/pdf, 182.4 KB — inline')
  })

  test('a disposition-inline part without a cid is not marked inline', async () => {
    const result = await getEmail(
      deps([
        {
          attachments: [
            { blobId: 'b1', disposition: 'inline', name: 'scan.pdf', partId: '2', size: 1024, type: 'application/pdf' },
          ],
          id: 'e1',
          subject: 'Scan',
          textBody: [],
        },
      ]),
      { args: { id: 'e1' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('1. scan.pdf — application/pdf, 1.0 KB — blobId: b1')
    expect(txt).not.toContain('— inline —')
  })

  test('renders no attachments section when there are none', async () => {
    const result = await getEmail(deps([{ attachments: [], id: 'e1', subject: 'Plain', textBody: [] }]), {
      args: { id: 'e1' },
      token: 'tok',
    })
    expect(result.content[0]?.text ?? '').not.toContain('Attachments')
  })
})
