import { describe, expect, test } from 'bun:test'

import { type EmailQueryParams } from '../jmap/email.ts'
import { type EmailRecord } from '../jmap/types.ts'
import { searchEmails, searchEmailsInput } from './search-emails.ts'

const fakeDeps = (opts: {
  accountId?: string
  mailboxByName?: (name: string) => string | null
  queryIds?: string[]
  emails?: EmailRecord[]
  onQuery?: (p: EmailQueryParams) => void
}) => ({
  emailGet: () => Promise.resolve(opts.emails ?? []),
  emailQuery: (p: EmailQueryParams) => {
    opts.onQuery?.(p)
    return Promise.resolve(opts.queryIds ?? [])
  },
  resolveAccountId: () => Promise.resolve(opts.accountId ?? 'acct'),
  resolveMailbox: (_token: string, name: string) =>
    Promise.resolve(opts.mailboxByName ? opts.mailboxByName(name) : null),
})

describe('searchEmailsInput schema', () => {
  test('rejects empty query', () => {
    const r = searchEmailsInput.safeParse({ query: '' })
    expect(r.success).toBe(false)
  })

  test('rejects limit > 100', () => {
    const r = searchEmailsInput.safeParse({ limit: 9999, query: 'x' })
    expect(r.success).toBe(false)
  })

  test('defaults limit to 20 when omitted', () => {
    const r = searchEmailsInput.parse({ query: 'x' })
    expect(r.limit).toBe(20)
  })

  test('rejects query > 500 chars', () => {
    const r = searchEmailsInput.safeParse({ query: 'a'.repeat(501) })
    expect(r.success).toBe(false)
  })

  test('rejects a call with no filter at all', () => {
    const r = searchEmailsInput.safeParse({ limit: 10 })
    expect(r.success).toBe(false)
  })

  test('accepts a keyword-only search (no free-text query)', () => {
    const r = searchEmailsInput.safeParse({ keywords: ['receipt'] })
    expect(r.success).toBe(true)
  })

  test('accepts a date-range-only search', () => {
    const r = searchEmailsInput.safeParse({ after: '2026-04-01T00:00:00Z' })
    expect(r.success).toBe(true)
  })

  test('rejects an unknown keyword value', () => {
    const r = searchEmailsInput.safeParse({ keywords: ['not-a-real-label'] })
    expect(r.success).toBe(false)
  })

  test('rejects a non-ISO after date', () => {
    const r = searchEmailsInput.safeParse({ after: 'last tuesday' })
    expect(r.success).toBe(false)
  })

  test('rejects a non-UTC (offset) timestamp — JMAP UTCDate requires Z', () => {
    expect(searchEmailsInput.safeParse({ after: '2026-04-01T00:00:00+02:00' }).success).toBe(false)
    expect(searchEmailsInput.safeParse({ before: '2026-04-01T00:00:00-05:00' }).success).toBe(false)
  })
})

describe('searchEmails', () => {
  test('returns a formatted text block with id/subject/sender/date', async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [
          {
            from: [{ email: 'smoketest@langmail.me', name: 'Smoketest' }],
            id: 'e1',
            mailboxIds: { mbx: true },
            preview: 'hello',
            receivedAt: '2026-01-01T00:00:00Z',
            subject: 'smoke-12345',
          },
        ],
        queryIds: ['e1'],
      }),
      { args: { limit: 20, query: 'smoke-12345' }, token: 'tok' }
    )
    expect(result.content[0]?.type).toBe('text')
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('smoke-12345')
    expect(txt).toContain('id: e1')
    expect(txt).toContain('smoketest@langmail.me')
    expect(txt).toContain('2026-01-01')
  })

  test("shows a matched message's $label tags stripped of the prefix", async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [
          {
            from: [{ email: 'store@shop.example' }],
            id: 'e1',
            keywords: { '$label:receipt': true, $seen: true },
            receivedAt: '2026-05-01T00:00:00Z',
            subject: 'Your order shipped',
          },
        ],
        queryIds: ['e1'],
      }),
      { args: { keywords: ['receipt'], limit: 20 }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('tags: receipt')
    // System flags are not surfaced as tags.
    expect(txt).not.toContain('$seen')
  })

  test('maps keyword enum values to $label: filters (todo -> to-do), no stray text', async () => {
    let seen: EmailQueryParams | undefined
    await searchEmails(fakeDeps({ onQuery: (p) => (seen = p), queryIds: [] }), {
      args: { keywords: ['receipt', 'todo'], limit: 20 },
      token: 'tok',
    })
    // Exact shape: a keyword-only search carries no text/date/mailbox condition.
    expect(seen?.filters).toEqual({ keywords: ['$label:receipt', '$label:to-do'] })
  })

  test('threads text + date + from filters through to the query', async () => {
    let seen: EmailQueryParams | undefined
    await searchEmails(fakeDeps({ onQuery: (p) => (seen = p), queryIds: [] }), {
      args: { after: '2026-04-01T00:00:00Z', from: 'amazon', limit: 20, query: 'invoice' },
      token: 'tok',
    })
    expect(seen?.filters).toEqual({ after: '2026-04-01T00:00:00Z', from: 'amazon', text: 'invoice' })
  })

  test('preserves the query id order (trusts the query sort, does not re-sort by receivedAt)', async () => {
    const result = await searchEmails(
      fakeDeps({
        // receivedAt would sort 'alpha' (newer) first, but the query returned
        // bravo then alpha. The tool must follow the query order, not receivedAt.
        emails: [
          { id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' },
          { id: 'b', receivedAt: '2026-01-01T00:00:00Z', subject: 'bravo' },
        ],
        queryIds: ['b', 'a'],
      }),
      { args: { limit: 20, query: 'x' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt.indexOf('bravo')).toBeLessThan(txt.indexOf('alpha'))
    expect(txt).toContain('1. bravo')
    expect(txt).toContain('2. alpha')
  })

  test("reports 'no messages' on empty hit set", async () => {
    const result = await searchEmails(fakeDeps({ emails: [], queryIds: [] }), {
      args: { limit: 20, query: 'nothing' },
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt.toLowerCase()).toContain('no messages')
  })

  test('resolves mailbox name to id before querying', async () => {
    let seenMailboxId: string | undefined
    const result = await searchEmails(
      {
        emailGet: () => Promise.resolve([]),
        emailQuery: (p) => {
          seenMailboxId = p.filters.mailboxId
          return Promise.resolve([])
        },
        resolveAccountId: () => Promise.resolve('acct'),
        resolveMailbox: (_token, name) => Promise.resolve(name === 'Inbox' ? 'm1' : null),
      },
      { args: { limit: 5, mailbox: 'Inbox', query: 'x' }, token: 'tok' }
    )
    expect(seenMailboxId).toBe('m1')
    // Empty result still returns a valid response.
    expect(result.content[0]?.text).toBeDefined()
  })

  test('returns a user-readable error when the named mailbox is unknown', async () => {
    const result = await searchEmails(fakeDeps({ mailboxByName: () => null }), {
      args: { limit: 5, mailbox: 'DoesNotExist', query: 'x' },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    const txt = result.content[0]?.text ?? ''
    expect(txt.toLowerCase()).toContain('mailbox')
    expect(txt).toContain('DoesNotExist')
  })
})
