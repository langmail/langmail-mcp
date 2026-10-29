import { describe, expect, test } from 'bun:test'

import {
  type EmailQueryParams,
  type EmailQueryPerTermParams,
  type EmailQueryTotalParams,
  type EmailRecord,
} from '@langmail/jmap'

import { queryTerms, searchEmails, searchEmailsInput } from './search-emails.ts'

// Distinguishes per-hit "matched: X/N terms" lines from the "N message(s)
// matched:" header.
const MATCHED_LINE_RE = /matched: \d/

const fakeDeps = (opts: {
  accountId?: string
  available?: string[]
  mailboxByName?: (name: string) => string | null
  queryIds?: string[]
  perTermIds?: string[][]
  emails?: EmailRecord[]
  onQuery?: (p: EmailQueryParams) => void
  onPerTermQuery?: (p: EmailQueryPerTermParams) => void
  onTotalQuery?: (p: EmailQueryTotalParams) => void
  total?: number
}) => ({
  emailGet: () => Promise.resolve(opts.emails ?? []),
  emailQuery: (p: EmailQueryParams) => {
    opts.onQuery?.(p)
    return Promise.resolve(opts.queryIds ?? [])
  },
  emailQueryPerTerm: (p: EmailQueryPerTermParams) => {
    opts.onPerTermQuery?.(p)
    return Promise.resolve(opts.perTermIds ?? p.terms.map(() => []))
  },
  emailQueryTotal: (p: EmailQueryTotalParams) => {
    opts.onTotalQuery?.(p)
    return Promise.resolve(opts.total ?? 0)
  },
  resolveAccountId: () => Promise.resolve(opts.accountId ?? 'acct'),
  resolveMailbox: (_authorization: string, name: string) =>
    Promise.resolve({ available: opts.available ?? [], id: opts.mailboxByName ? opts.mailboxByName(name) : null }),
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

  test('accepts a read-state-only search, read: false included', () => {
    expect(searchEmailsInput.safeParse({ read: false }).success).toBe(true)
    expect(searchEmailsInput.safeParse({ starred: true }).success).toBe(true)
  })

  test('accepts a keyword-only search (no free-text query)', () => {
    const r = searchEmailsInput.safeParse({ keywords: ['receipt'] })
    expect(r.success).toBe(true)
  })

  // The types no agent labels — previously absent from the enum entirely.
  test('accepts the full taxonomy, including ticket and scheduling', () => {
    expect(searchEmailsInput.safeParse({ keywords: ['ticket'] }).success).toBe(true)
    expect(searchEmailsInput.safeParse({ keywords: ['scheduling', 'security_alert'] }).success).toBe(true)
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

describe('queryTerms', () => {
  test('splits whitespace-separated words into terms', () => {
    expect(queryTerms('Supabase invoice receipt')).toEqual(['Supabase', 'invoice', 'receipt'])
  })

  test('keeps a quoted phrase together and strips the quotes', () => {
    expect(queryTerms('"Google Workspace" invoice')).toEqual(['Google Workspace', 'invoice'])
  })

  test('collapses extra whitespace and drops empty quotes', () => {
    expect(queryTerms('  invoice   ""  ')).toEqual(['invoice'])
  })

  test('a single word is a single term', () => {
    expect(queryTerms('invoice')).toEqual(['invoice'])
  })

  test('an unbalanced quote degrades to plain word terms (quote kept literally)', () => {
    expect(queryTerms('bar "baz qux')).toEqual(['bar', '"baz', 'qux'])
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

  test('renders preview snippets and attachment metadata in search hits', async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [
          {
            attachments: [
              {
                blobId: 'Ginvoice',
                disposition: 'attachment',
                name: 'invoice.pdf',
                size: 35_738,
                type: 'application/pdf',
              },
            ],
            from: [{ email: 'billing@example.com', name: 'Billing' }],
            hasAttachment: true,
            id: 'e1',
            preview: 'Invoice No. IWGKCS-00018 · $34.86',
            receivedAt: '2026-01-01T00:00:00Z',
            subject: 'Invoice',
          },
        ],
        queryIds: ['e1'],
      }),
      { args: { limit: 20, query: 'invoice' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('snippet: Invoice No. IWGKCS-00018 · $34.86')
    expect(txt).toContain('invoice.pdf — application/pdf, 34.9 KB — blobId: Ginvoice')
  })

  test("shows a matched message's tags stripped of the prefix", async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [
          {
            from: [{ email: 'store@shop.example' }],
            id: 'e1',
            keywords: { '$label:receipt': true, $seen: true, '$type:order': true },
            receivedAt: '2026-05-01T00:00:00Z',
            subject: 'Your order shipped',
          },
        ],
        queryIds: ['e1'],
      }),
      { args: { keywords: ['receipt'], limit: 20 }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('tags: receipt, order')
    // System flags are not surfaced as tags.
    expect(txt).not.toContain('$seen')
  })

  test('maps read and starred onto required $seen / $flagged states', async () => {
    let seen: EmailQueryParams | undefined
    await searchEmails(
      fakeDeps({
        onQuery: (p) => {
          seen = p
        },
      }),
      { args: { limit: 20, read: false, starred: true }, token: 'tok' }
    )
    expect(seen?.filters).toEqual({ keywordStates: { $flagged: true, $seen: false } })
  })

  test('shows unread and starred flags on a hit', async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [{ id: 'e1', keywords: { $flagged: true }, subject: 'Message from a recruiter' }],
        queryIds: ['e1'],
      }),
      { args: { limit: 20, read: false }, token: 'tok' }
    )
    expect(result.content[0]?.text ?? '').toContain('flags: unread, starred')
  })

  test('maps type values to $type: filters and todo to $label:, no stray text', async () => {
    let seen: EmailQueryParams | undefined
    await searchEmails(
      fakeDeps({
        onQuery: (p) => {
          seen = p
        },
        queryIds: [],
      }),
      {
        args: { keywords: ['receipt', 'todo'], limit: 20 },
        token: 'tok',
      }
    )
    // Exact shape: a keyword-only search carries no text/date/mailbox condition.
    expect(seen?.filters).toEqual({ keywords: ['$type:receipt', '$label:todo'] })
  })

  // The motivating shape: a type filter plus a received-date window, no
  // free-text at all — one call instead of two speculative keyword searches.
  test('composes a ticket filter with a date window and limit', async () => {
    let seen: EmailQueryParams | undefined
    await searchEmails(
      fakeDeps({
        onQuery: (p) => {
          seen = p
        },
        queryIds: [],
      }),
      {
        args: {
          after: '2026-07-01T00:00:00Z',
          before: '2026-07-31T00:00:00Z',
          keywords: ['ticket'],
          limit: 5,
        },
        token: 'tok',
      }
    )
    expect(seen?.filters).toEqual({
      after: '2026-07-01T00:00:00Z',
      before: '2026-07-31T00:00:00Z',
      keywords: ['$type:ticket'],
    })
    expect(seen?.limit).toBe(5)
  })

  test('threads text + date + from filters through to the query', async () => {
    let seen: EmailQueryParams | undefined
    await searchEmails(
      fakeDeps({
        onQuery: (p) => {
          seen = p
        },
        queryIds: [],
      }),
      {
        args: { after: '2026-04-01T00:00:00Z', from: 'amazon', limit: 20, query: 'invoice' },
        token: 'tok',
      }
    )
    expect(seen?.filters).toEqual({ after: '2026-04-01T00:00:00Z', from: 'amazon', text: ['invoice'] })
  })

  test('routes a multi-word query through per-term queries with the scalar filters', async () => {
    let seen: EmailQueryPerTermParams | undefined
    await searchEmails(
      fakeDeps({
        onPerTermQuery: (p) => {
          seen = p
        },
      }),
      {
        args: { after: '2026-04-17T00:00:00Z', limit: 20, query: 'Supabase invoice receipt', read: false },
        token: 'tok',
      }
    )
    expect(seen?.terms).toEqual(['Supabase', 'invoice', 'receipt'])
    expect(seen?.filters).toEqual({ after: '2026-04-17T00:00:00Z', keywordStates: { $seen: false } })
  })

  test('keeps a double-quoted phrase as a single term in the per-term fan-out', async () => {
    let seen: EmailQueryPerTermParams | undefined
    await searchEmails(
      fakeDeps({
        onPerTermQuery: (p) => {
          seen = p
        },
      }),
      { args: { limit: 20, query: '"Google Workspace" invoice' }, token: 'tok' }
    )
    expect(seen?.terms).toEqual(['Google Workspace', 'invoice'])
  })

  test('ranks messages matching more terms first and renders matched counts', async () => {
    // 'both' matches two term lists, 'single' only one — but 'single' is
    // newer. Match count must beat recency.
    const emails: EmailRecord[] = [
      { id: 'single', receivedAt: '2026-07-10T00:00:00Z', subject: 'newer single-term hit' },
      { id: 'both', receivedAt: '2026-06-01T00:00:00Z', subject: 'older double-term hit' },
    ]
    const result = await searchEmails(
      fakeDeps({
        emails,
        perTermIds: [['single', 'both'], ['both'], []],
      }),
      { args: { limit: 20, query: 'alpha bravo charlie' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt.indexOf('older double-term hit')).toBeLessThan(txt.indexOf('newer single-term hit'))
    expect(txt).toContain('1. older double-term hit')
    expect(txt).toContain('matched: 2/3 terms')
    expect(txt).toContain('matched: 1/3 terms')
  })

  test('ties on match count fall back to newest-first', async () => {
    const emails: EmailRecord[] = [
      { id: 'old', receivedAt: '2026-01-01T00:00:00Z', subject: 'old tie' },
      { id: 'new', receivedAt: '2026-07-01T00:00:00Z', subject: 'new tie' },
    ]
    const result = await searchEmails(
      fakeDeps({
        emails,
        perTermIds: [
          ['old', 'new'],
          ['new', 'old'],
        ],
      }),
      { args: { limit: 20, query: 'alpha bravo' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('1. new tie')
    expect(txt).toContain('2. old tie')
  })

  test('caps ranked hits at the limit and reports the total', async () => {
    let seenTotal: EmailQueryTotalParams | undefined
    const emails: EmailRecord[] = [
      { id: 'a', receivedAt: '2026-06-03T00:00:00Z', subject: 'hit a' },
      { id: 'b', receivedAt: '2026-06-02T00:00:00Z', subject: 'hit b' },
    ]
    const result = await searchEmails(
      fakeDeps({
        emails,
        onTotalQuery: (p) => {
          seenTotal = p
        },
        perTermIds: [
          ['a', 'b'],
          ['b', 'c'],
        ],
        total: 3,
      }),
      { args: { limit: 2, query: 'alpha bravo', starred: true }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    // 'b' matched both terms and ranks first; 'c' fell past the limit.
    expect(txt).toContain('1. hit b')
    expect(txt).toStartWith('2 of 3 message(s) matched — 1 more not shown.')
    // The total counts the union of all terms, not one term's hits.
    expect(seenTotal?.filters.text).toEqual(['alpha', 'bravo'])
    expect(seenTotal?.filters.keywordStates).toEqual({ $flagged: true })
  })

  // A per-term window that filled up may hide older multi-term hits, so the
  // page counts as full even though the ranked list fits the limit.
  test('a filled per-term window triggers the count', async () => {
    const window = Array.from({ length: 60 }, (_, i) => `w${i}`)
    const emails: EmailRecord[] = window
      .slice(0, 20)
      .map((id) => ({ id, receivedAt: '2026-06-01T00:00:00Z', subject: id }))
    let counted = false
    const result = await searchEmails(
      fakeDeps({
        emails,
        onTotalQuery: () => {
          counted = true
        },
        perTermIds: [window, []],
        total: 75,
      }),
      { args: { limit: 20, query: 'alpha bravo' }, token: 'tok' }
    )
    expect(counted).toBe(true)
    expect(result.content[0]?.text).toStartWith('20 of 75 message(s) matched — 55 more not shown.')
  })

  test('caps the fan-out at 10 terms and widens the per-term window', async () => {
    let seen: EmailQueryPerTermParams | undefined
    await searchEmails(
      fakeDeps({
        onPerTermQuery: (p) => {
          seen = p
        },
      }),
      { args: { limit: 20, query: 't1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12' }, token: 'tok' }
    )
    expect(seen?.terms).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'])
    expect(seen?.limit).toBe(60)
  })

  test('multi-term query with no hits in any term reports no messages', async () => {
    const result = await searchEmails(fakeDeps({ perTermIds: [[], []] }), {
      args: { limit: 20, query: 'alpha bravo' },
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt.toLowerCase()).toContain('no messages')
  })

  test('single-term queries keep plain newest-first output without matched lines', async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [{ id: 'e1', receivedAt: '2026-06-01T00:00:00Z', subject: 'only hit' }],
        queryIds: ['e1'],
      }),
      { args: { limit: 20, query: 'invoice' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('only hit')
    expect(txt).not.toMatch(MATCHED_LINE_RE)
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

  test('a full page reports the total and how many more match', async () => {
    const emails: EmailRecord[] = [
      { id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' },
      { id: 'b', receivedAt: '2026-05-01T00:00:00Z', subject: 'bravo' },
    ]
    let seenTotal: EmailQueryTotalParams | undefined
    const result = await searchEmails(
      fakeDeps({
        emails,
        onTotalQuery: (p) => {
          seenTotal = p
        },
        queryIds: ['a', 'b'],
        total: 213,
      }),
      { args: { from: 'billing', limit: 2, query: 'invoice' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('2 of 213 message(s) matched — 211 more not shown.')
    expect(txt).toContain('raise limit')
    // Counted with the same filter the page used.
    expect(seenTotal?.filters).toEqual({ from: 'billing', text: ['invoice'] })
  })

  test('a full page that holds every match reports it as complete', async () => {
    const emails: EmailRecord[] = [
      { id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' },
      { id: 'b', receivedAt: '2026-05-01T00:00:00Z', subject: 'bravo' },
    ]
    const result = await searchEmails(fakeDeps({ emails, queryIds: ['a', 'b'], total: 2 }), {
      args: { limit: 2, query: 'invoice' },
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('2 of 2 message(s) matched:')
    expect(txt).not.toContain('not shown')
  })

  test('a page under the limit is the total and skips the count query', async () => {
    const emails: EmailRecord[] = [{ id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' }]
    let counted = false
    const result = await searchEmails(
      fakeDeps({
        emails,
        onTotalQuery: () => {
          counted = true
        },
        queryIds: ['a'],
      }),
      { args: { limit: 20, query: 'invoice' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('1 of 1 message(s) matched:')
    expect(txt).not.toContain('not shown')
    expect(counted).toBe(false)
  })

  test('a total smaller than the page never undercounts what is shown', async () => {
    const emails: EmailRecord[] = [
      { id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' },
      { id: 'b', receivedAt: '2026-05-01T00:00:00Z', subject: 'bravo' },
    ]
    const result = await searchEmails(fakeDeps({ emails, queryIds: ['a', 'b'], total: 1 }), {
      args: { limit: 2, query: 'invoice' },
      token: 'tok',
    })
    expect(result.content[0]?.text).toStartWith('2 of 2 message(s) matched:')
  })

  test('does not suggest raising a limit that is already at the maximum', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `e${i}`)
    const emails: EmailRecord[] = ids.map((id) => ({ id, receivedAt: '2026-06-01T00:00:00Z', subject: id }))
    const result = await searchEmails(fakeDeps({ emails, queryIds: ids, total: 150 }), {
      args: { limit: 100, query: 'invoice' },
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('100 of 150 message(s) matched — 50 more not shown.')
    expect(txt).not.toContain('raise limit')
  })

  test('a failed count keeps the page and reports the total as a lower bound', async () => {
    const emails: EmailRecord[] = [
      { id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' },
      { id: 'b', receivedAt: '2026-05-01T00:00:00Z', subject: 'bravo' },
    ]
    const result = await searchEmails(
      { ...fakeDeps({ emails, queryIds: ['a', 'b'] }), emailQueryTotal: () => Promise.reject(new Error('timeout')) },
      { args: { limit: 2, query: 'invoice' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(result.isError).toBeFalsy()
    expect(txt).toStartWith('2 of at least 2 message(s) matched')
    expect(txt).toContain('1. alpha')
  })

  test('a count that misses its deadline keeps the page and reports a lower bound', async () => {
    const emails: EmailRecord[] = [
      { id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' },
      { id: 'b', receivedAt: '2026-05-01T00:00:00Z', subject: 'bravo' },
    ]
    const result = await searchEmails(
      { ...fakeDeps({ emails, queryIds: ['a', 'b'] }), emailQueryTotal: () => new Promise<number>(() => undefined) },
      { args: { limit: 2, query: 'invoice' }, countDeadlineMs: 10, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('2 of at least 2 message(s) matched')
    expect(txt).toContain('2. bravo')
  })

  test('a message gone between query and fetch on a partial page is not reported as cut off', async () => {
    const emails: EmailRecord[] = [{ id: 'a', receivedAt: '2026-06-01T00:00:00Z', subject: 'alpha' }]
    const result = await searchEmails(fakeDeps({ emails, queryIds: ['a', 'gone'] }), {
      args: { limit: 20, query: 'invoice' },
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('1 of 1 message(s) matched:')
    expect(txt).not.toContain('not shown')
  })

  test('rejects a query that tokenizes to zero terms instead of matching everything', async () => {
    let queried = false
    const result = await searchEmails(
      fakeDeps({
        onQuery: () => {
          queried = true
        },
      }),
      { args: { limit: 20, query: '""' }, token: 'tok' }
    )
    expect(result.isError).toBe(true)
    expect(queried).toBe(false)
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
        emailQueryPerTerm: () => Promise.resolve([]),
        emailQueryTotal: () => Promise.resolve(0),
        resolveAccountId: () => Promise.resolve('acct'),
        resolveMailbox: (_authorization, name) =>
          Promise.resolve({ available: [], id: name === 'Inbox' ? 'm1' : null }),
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

  test('a miss names the folders that do exist', async () => {
    // A bare "not found" on a folder the server names differently reads as
    // "those messages were never synced"; the listing is what unsticks it.
    const result = await searchEmails(fakeDeps({ available: ['Inbox', 'Sent Items'], mailboxByName: () => null }), {
      args: { limit: 5, mailbox: 'Sent', query: 'x' },
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text ?? '').toContain('Sent Items')
  })
})
