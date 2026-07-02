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
})
