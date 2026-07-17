import { describe, expect, test } from 'bun:test'

import { type EmailDetailRecord } from '@langmail/jmap'

import { getEmail, getEmailInput } from './get-email.ts'

const deps = (emails: EmailDetailRecord[]) => ({
  emailGetDetail: () => Promise.resolve(emails),
  resolveAccountId: () => Promise.resolve('acct'),
})

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
