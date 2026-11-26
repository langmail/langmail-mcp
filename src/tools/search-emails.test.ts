import { describe, expect, test } from 'bun:test'

import {
  type EmailQueryParams,
  type EmailQueryPerTermParams,
  type EmailQueryTotalParams,
  type EmailRecord,
  type MailboxRecord,
} from '../jmap/index.ts'
import {
  decodeCursor,
  encodeCursor,
  queryTerms,
  searchEmails,
  searchEmailsInput,
  searchFingerprint,
  selfHostedSearchEmailsInput,
} from './search-emails.ts'

// Distinguishes per-hit "matched: X/N terms" lines from the "N message(s)
// matched:" header.
const MATCHED_LINE_RE = /matched: \d/

const fakeDeps = (opts: {
  accountId?: string
  available?: string[]
  mailboxByName?: (name: string) => string | null
  queryIds?: string[]
  // Multi-term searches query two tiers: every term ('all'), then only some.
  tierIds?: { all?: string[]; some?: string[] }
  perTermIds?: string[][]
  emails?: EmailRecord[]
  mailboxes?: MailboxRecord[]
  onQuery?: (p: EmailQueryParams) => void
  onPerTermQuery?: (p: EmailQueryPerTermParams) => void
  onTotalQuery?: (p: EmailQueryTotalParams) => void
  total?: number
}) => ({
  emailGet: () => Promise.resolve(opts.emails ?? []),
  emailQuery: (p: EmailQueryParams) => {
    opts.onQuery?.(p)
    if (opts.tierIds && p.filters.textMatch) {
      return Promise.resolve((p.filters.textMatch === 'all' ? opts.tierIds.all : opts.tierIds.some) ?? [])
    }
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
  mailboxList: () => Promise.resolve(opts.mailboxes ?? []),
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

  test('keeps a quoted phrase together, quoted, so Stalwart matches it as a phrase', () => {
    expect(queryTerms('"Acme Workspace" invoice')).toEqual(['"Acme Workspace"', 'invoice'])
  })

  test('trims the inside of a quoted phrase', () => {
    expect(queryTerms('" Acme Workspace "')).toEqual(['"Acme Workspace"'])
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
  test('each hit names its folders, so a Junk hit reads as spam', async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: [
          { id: 'a', mailboxIds: { 'mb-inbox': true }, subject: 'Lunch?' },
          { id: 'b', mailboxIds: { 'mb-junk': true }, subject: 'You won' },
        ],
        mailboxes: [
          { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
          { id: 'mb-junk', name: 'Junk Mail', role: 'junk' },
        ],
        queryIds: ['a', 'b'],
      }),
      { args: { limit: 20, read: false }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('1. Lunch?\n   id: a\n   from: (unknown sender)\n   date: \n   folders: Inbox')
    expect(txt).toContain('   folders: Junk')
  })

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
    // One past the page, to tell a full last page from one with more behind it.
    expect(seen?.limit).toBe(6)
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

  test('a multi-word query lists full matches first, then partial ones ranked within their dates', async () => {
    const queries: EmailQueryParams[] = []
    let perTerm: EmailQueryPerTermParams | undefined
    const result = await searchEmails(
      fakeDeps({
        emails: [
          { id: 'full', receivedAt: '2026-01-01T00:00:00Z', subject: 'old full match' },
          { id: 'a', receivedAt: '2026-06-03T00:00:00Z', subject: 'a' },
          { id: 'b', receivedAt: '2026-05-01T00:00:00Z', subject: 'b' },
        ],
        onPerTermQuery: (p) => {
          perTerm = p
        },
        onQuery: (p) => queries.push(p),
        tierIds: { all: ['full'], some: ['a', 'b'] },
      }),
      {
        args: { after: '2026-04-17T00:00:00Z', limit: 20, query: 'Supabase invoice receipt', read: false },
        token: 'tok',
      }
    )
    const scalars = { after: '2026-04-17T00:00:00Z', keywordStates: { $seen: false } }
    const text = ['Supabase', 'invoice', 'receipt']
    expect(queries.map((q) => q.filters)).toEqual([
      { ...scalars, text, textMatch: 'all' },
      { ...scalars, text, textMatch: 'someButNotAll' },
    ])
    // The full match tops the list though it is the oldest.
    expect(result.content[0]?.text).toContain('1. old full match')
    expect(result.content[0]?.text).toContain('matched: 3/3 terms')
    expect(perTerm?.terms).toEqual(text)
    // Bounded to the partial hits' oldest and newest second, so each count is exact.
    // Full matches stay out, so they can't crowd partial hits out of the limit.
    expect(perTerm?.filters).toEqual({
      after: '2026-05-01T00:00:00.000Z',
      before: '2026-06-03T00:00:01.000Z',
      keywordStates: { $seen: false },
      withoutAllOf: text,
    })
  })

  test('a page filled by full matches only peeks at the partial tier for a cursor', async () => {
    const queries: EmailQueryParams[] = []
    const result = await searchEmails(
      fakeDeps({
        emails: [{ id: 'full', receivedAt: '2026-01-01T00:00:00Z', subject: 'full' }],
        onQuery: (p) => queries.push(p),
        tierIds: { all: ['full'], some: ['a'] },
        total: 2,
      }),
      { args: { limit: 1, query: 'alpha bravo' }, token: 'tok' }
    )
    expect(queries.map((q) => [q.filters.textMatch, q.limit])).toEqual([
      ['all', 2],
      ['someButNotAll', 1],
    ])
    expect(result.content[0]?.text).toContain('cursor: "v1.')
  })

  test('a page that ends with the last match prints no cursor, whatever the count says', async () => {
    // The count saw one more (mail arriving in between); the page query, which
    // asked for one past the page, saw none, and it decides.
    const result = await searchEmails(
      fakeDeps({
        emails: [{ id: 'a', receivedAt: '2026-01-01T00:00:00Z', subject: 'a' }],
        queryIds: ['a'],
        total: 2,
      }),
      { args: { keywords: ['receipt'], limit: 1 }, token: 'tok' }
    )
    expect(result.content[0]?.text).toStartWith('1 of 1 message(s) matched:')
  })

  test('sends a double-quoted phrase quoted, as one term, in the per-term fan-out', async () => {
    let seen: EmailQueryPerTermParams | undefined
    await searchEmails(
      fakeDeps({
        emails: [{ id: 'a', receivedAt: '2026-06-03T00:00:00Z', subject: 'a' }],
        onPerTermQuery: (p) => {
          seen = p
        },
        tierIds: { some: ['a'] },
      }),
      { args: { limit: 20, query: '"Acme Workspace" invoice' }, token: 'tok' }
    )
    expect(seen?.terms).toEqual(['"Acme Workspace"', 'invoice'])
  })

  test('ranks partial matches holding more terms first and renders matched counts', async () => {
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
        tierIds: { some: ['single', 'both'] },
      }),
      { args: { limit: 20, query: 'alpha bravo charlie' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('1. older double-term hit')
    expect(txt).toContain('2. newer single-term hit')
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
        perTermIds: [['old'], ['new']],
        // Out of order on purpose: the tie-break, not the query order, decides.
        tierIds: { some: ['old', 'new'] },
      }),
      { args: { limit: 20, query: 'alpha bravo' }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('1. new tie')
    expect(txt).toContain('2. old tie')
  })

  test('a full multi-term page reports the total of the union and prints a cursor', async () => {
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
        perTermIds: [['a', 'b'], ['b']],
        tierIds: { some: ['a', 'b', 'c'] },
        total: 3,
      }),
      { args: { limit: 2, query: 'alpha bravo', starred: true }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('2 of 3 message(s) matched — 1 more not shown.')
    expect(txt).toContain('cursor: "v1.')
    // A first page counts the union of all terms, not one tier.
    expect(seenTotal?.filters.text).toEqual(['alpha', 'bravo'])
    expect(seenTotal?.filters.textMatch).toBeUndefined()
    expect(seenTotal?.filters.keywordStates).toEqual({ $flagged: true })
  })

  test('caps the fan-out at 10 terms', async () => {
    let seen: EmailQueryPerTermParams | undefined
    await searchEmails(
      fakeDeps({
        emails: [{ id: 'a', receivedAt: '2026-06-03T00:00:00Z', subject: 'a' }],
        onPerTermQuery: (p) => {
          seen = p
        },
        tierIds: { some: ['a'] },
      }),
      { args: { limit: 20, query: 't1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12' }, token: 'tok' }
    )
    expect(seen?.terms).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'])
  })

  test('a multi-term query that neither tier matches reports no messages', async () => {
    const result = await searchEmails(fakeDeps({ tierIds: {} }), {
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
        queryIds: ['a', 'b', 'c'],
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
    const result = await searchEmails(fakeDeps({ emails, queryIds: [...ids, 'more'], total: 150 }), {
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
      {
        ...fakeDeps({ emails, queryIds: ['a', 'b', 'c'] }),
        emailQueryTotal: () => Promise.reject(new Error('timeout')),
      },
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
      {
        ...fakeDeps({ emails, queryIds: ['a', 'b', 'c'] }),
        emailQueryTotal: () => new Promise<number>(() => undefined),
      },
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
        mailboxList: () => Promise.resolve([]),
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

const CURSOR_RE = /cursor: "(v1\.[\w-]+)"/u

const cursorIn = (text: string): string | undefined => CURSOR_RE.exec(text)?.[1]

describe('searchEmails paging', () => {
  const page = (...hits: [string, string][]): EmailRecord[] =>
    hits.map(([id, receivedAt]) => ({ id, receivedAt, subject: `subject ${id}` }))

  type Args = Parameters<typeof searchEmails>[1]['args']

  // A cursor as the tool would print it for `args`.
  const cursorFor = (args: Args, seen: string[], watermark: string, tier: 'all' | 'any' | 'some' = 'any'): string =>
    encodeCursor({ search: searchFingerprint(args), seen, tier, watermark })

  const receipts: Args = { keywords: ['receipt'], limit: 2 }

  test('a full page with more matches prints a cursor marking its oldest hit', async () => {
    const emails = page(['a', '2026-06-03T00:00:00Z'], ['b', '2026-06-02T00:00:00Z'])
    const result = await searchEmails(fakeDeps({ emails, queryIds: ['a', 'b', 'c'], total: 5 }), {
      args: receipts,
      token: 'tok',
    })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith(
      '2 of 5 message(s) matched — 3 more not shown. For the next page, repeat this search with cursor: "v1.'
    )
    const cursor = cursorIn(txt)
    expect(cursor && decodeCursor(cursor)).toEqual({
      search: searchFingerprint(receipts),
      seen: ['b'],
      tier: 'any',
      watermark: '2026-06-02T00:00:00Z',
    })
  })

  test('a page that holds every match prints no cursor', async () => {
    const emails = page(['a', '2026-06-03T00:00:00Z'], ['b', '2026-06-02T00:00:00Z'])
    const counted = await searchEmails(fakeDeps({ emails, queryIds: ['a', 'b'], total: 2 }), {
      args: receipts,
      token: 'tok',
    })
    expect(counted.content[0]?.text).not.toContain('cursor')
    const partial = await searchEmails(fakeDeps({ emails, queryIds: ['a', 'b'] }), {
      args: { ...receipts, limit: 3 },
      token: 'tok',
    })
    expect(partial.content[0]?.text).not.toContain('cursor')
  })

  test('an uncountable total still prints a cursor', async () => {
    const emails = page(['a', '2026-06-03T00:00:00Z'])
    const result = await searchEmails(
      { ...fakeDeps({ emails, queryIds: ['a', 'b'] }), emailQueryTotal: () => Promise.reject(new Error('timeout')) },
      { args: { ...receipts, limit: 1 }, token: 'tok' }
    )
    expect(cursorIn(result.content[0]?.text ?? '')).toBeDefined()
  })

  test('the next page starts in the watermark second and drops the hits already shown there', async () => {
    const queries: EmailQueryParams[] = []
    const totals: EmailQueryTotalParams[] = []
    const args: Args = { from: 'billing', limit: 2 }
    const first = await searchEmails(
      fakeDeps({
        emails: page(['a', '2026-06-03T00:00:00Z'], ['b', '2026-06-02T00:00:00Z']),
        queryIds: ['a', 'b', 'c'],
        total: 4,
      }),
      { args, token: 'tok' }
    )
    const cursor = cursorIn(first.content[0]?.text ?? '') ?? ''

    // 'b' comes back again (it sits in the watermark second) and 'c' shares
    // that second: 'b' is dropped, 'c' is kept.
    const second = await searchEmails(
      fakeDeps({
        emails: page(['c', '2026-06-02T00:00:00Z'], ['d', '2026-06-01T00:00:00Z']),
        onQuery: (p) => queries.push(p),
        onTotalQuery: (p) => totals.push(p),
        queryIds: ['b', 'c', 'd', 'e'],
        total: 4,
      }),
      { args: { ...args, cursor }, token: 'tok' }
    )
    const txt = second.content[0]?.text ?? ''
    expect(queries[0]?.filters).toEqual({ before: '2026-06-02T00:00:01.000Z', from: 'billing' })
    expect(queries[0]?.limit).toBe(4)
    expect(txt).toContain('1. subject c')
    expect(txt).toContain('2. subject d')
    expect(txt).not.toContain('subject b')
    // 4 counted up to the watermark second, one of them already shown.
    expect(totals[0]?.filters.before).toBe('2026-06-02T00:00:01.000Z')
    expect(txt).toStartWith('2 of 3 remaining message(s) matched — 1 more not shown.')
  })

  test('a page that ends in the same second carries the earlier shown ids forward', async () => {
    const args: Args = { ...receipts, limit: 1 }
    const second = await searchEmails(
      fakeDeps({ emails: page(['b', '2026-06-02T00:00:00Z']), queryIds: ['a', 'b', 'c'], total: 3 }),
      { args: { ...args, cursor: cursorFor(args, ['a'], '2026-06-02T00:00:00Z') }, token: 'tok' }
    )
    const next = cursorIn(second.content[0]?.text ?? '')
    expect(next && decodeCursor(next)?.seen).toEqual(['a', 'b'])
  })

  test('a shown hit that stopped matching is not taken off the remaining count', async () => {
    // 'a' was shown and then marked read: under read: false it no longer
    // comes back, so the 2 counted are both still ahead.
    const args: Args = { limit: 1, read: false }
    const result = await searchEmails(
      fakeDeps({ emails: page(['b', '2026-06-01T00:00:00Z']), queryIds: ['b', 'c'], total: 2 }),
      { args: { ...args, cursor: cursorFor(args, ['a'], '2026-06-02T00:00:00Z') }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toStartWith('1 of 2 remaining message(s) matched — 1 more not shown.')
    expect(cursorIn(txt)).toBeDefined()
  })

  test('a cursor in the full-match tier continues it, then moves on to partial matches', async () => {
    const args: Args = { limit: 3, query: 'alpha bravo' }
    const queries: EmailQueryParams[] = []
    const totals: EmailQueryTotalParams[] = []
    const result = await searchEmails(
      fakeDeps({
        emails: page(['f2', '2026-03-01T00:00:00Z'], ['p1', '2026-07-01T00:00:00Z'], ['p2', '2026-06-01T00:00:00Z']),
        onQuery: (p) => queries.push(p),
        onTotalQuery: (p) => totals.push(p),
        tierIds: { all: ['f1', 'f2'], some: ['p1', 'p2', 'p3'] },
        total: 3,
      }),
      { args: { ...args, cursor: cursorFor(args, ['f1'], '2026-04-01T00:00:00Z', 'all') }, token: 'tok' }
    )
    const txt = result.content[0]?.text ?? ''
    // The watermark bounds the full-match tier only; partial matches start
    // from their newest.
    expect(queries.map((q) => [q.filters.textMatch, q.filters.before])).toEqual([
      ['all', '2026-04-01T00:00:01.000Z'],
      ['someButNotAll', undefined],
    ])
    expect(txt).toContain('1. subject f2')
    // Remaining: each tier's own count (3 + 3), less the full match already shown.
    expect(totals).toHaveLength(2)
    expect(txt).toStartWith('3 of 5 remaining message(s) matched — 2 more not shown.')
    const next = cursorIn(txt)
    expect(next && decodeCursor(next)?.tier).toBe('some')
  })

  test('a shown hit that stops matching between page and count does not end the walk', async () => {
    // The page query still returned 'a' (shown before), then 'a' was marked
    // read before the count: 2 remain (b, c), and the cursor must survive.
    const args: Args = { limit: 1, read: false }
    const result = await searchEmails(
      fakeDeps({ emails: page(['b', '2026-06-01T00:00:00Z']), queryIds: ['a', 'b', 'c'], total: 2 }),
      { args: { ...args, cursor: cursorFor(args, ['a'], '2026-06-02T00:00:00Z') }, token: 'tok' }
    )
    expect(cursorIn(result.content[0]?.text ?? '')).toBeDefined()
  })

  test('keyword order does not make a cursor belong to another search', async () => {
    const args: Args = { keywords: ['order', 'receipt'], limit: 2 }
    const cursor = cursorFor(args, ['x'], '2026-06-02T00:00:00Z')
    const result = await searchEmails(fakeDeps({}), {
      args: { cursor, keywords: ['receipt', 'order'], limit: 2 },
      token: 'tok',
    })
    expect(result.isError).toBeFalsy()
  })

  test('a partial match missing from every per-term list still shows at least one matched term', async () => {
    const result = await searchEmails(
      fakeDeps({
        emails: page(['p', '2026-06-01T00:00:00Z']),
        perTermIds: [[], []],
        tierIds: { some: ['p'] },
      }),
      { args: { limit: 5, query: 'alpha bravo' }, token: 'tok' }
    )
    expect(result.content[0]?.text).toContain('matched: 1/2 terms')
  })

  test("an earlier before of the caller's own wins over the watermark", async () => {
    let seen: EmailQueryParams | undefined
    const args: Args = { ...receipts, before: '2026-05-01T00:00:00Z' }
    await searchEmails(
      fakeDeps({
        onQuery: (p) => {
          seen = p
        },
      }),
      { args: { ...args, cursor: cursorFor(args, ['x'], '2026-06-02T00:00:00Z') }, token: 'tok' }
    )
    expect(seen?.filters.before).toBe('2026-05-01T00:00:00Z')
  })

  test('a cursor past the last match says nothing more matched', async () => {
    const result = await searchEmails(fakeDeps({ queryIds: ['x'] }), {
      args: { ...receipts, cursor: cursorFor(receipts, ['x'], '2026-06-02T00:00:00Z') },
      token: 'tok',
    })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.text).toBe('No more messages matched after this cursor.')
  })

  test('a cursor may change the page size, not the filters', async () => {
    const cursor = cursorFor(receipts, ['x'], '2026-06-02T00:00:00Z')
    const resized = await searchEmails(fakeDeps({}), { args: { ...receipts, cursor, limit: 50 }, token: 'tok' })
    expect(resized.isError).toBeFalsy()

    let queried = false
    const other = await searchEmails(
      fakeDeps({
        onQuery: () => {
          queried = true
        },
      }),
      { args: { ...receipts, cursor, keywords: ['order'] }, token: 'tok' }
    )
    expect(other.isError).toBe(true)
    expect(other.content[0]?.text).toStartWith('cursor belongs to a search with other filters. Nothing was searched.')
    expect(queried).toBe(false)
  })

  test('a cursor search_emails did not print is refused before any query', async () => {
    let queried = false
    for (const cursor of ['garbage', 'v1.!!!', `v1.${Buffer.from('{"s":[]}').toString('base64url')}`]) {
      const result = await searchEmails(
        fakeDeps({
          onQuery: () => {
            queried = true
          },
        }),
        { args: { ...receipts, cursor }, token: 'tok' }
      )
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('Pass the cursor exactly as the result printed it')
    }
    expect(queried).toBe(false)
  })

  test('a cursor carrying many ids from one second still passes the input schema', () => {
    const seen = Array.from({ length: 2000 }, (_, i) => `id${String(i).padStart(7, '0')}`)
    const cursor = cursorFor(receipts, seen, '2026-06-02T00:00:00Z')
    expect(searchEmailsInput.safeParse({ ...receipts, cursor }).success).toBe(true)
    expect(decodeCursor(cursor)?.seen).toHaveLength(2000)
  })

  test('a cursor alone is not a filter', () => {
    expect(searchEmailsInput.safeParse({ cursor: 'v1.abc' }).success).toBe(false)
  })
})

describe('self-hosted todo filter', () => {
  test('maps todo onto a required or excluded $label:todo, the keyword mark_emails sets', async () => {
    for (const todo of [true, false]) {
      let seen: EmailQueryParams | undefined
      await searchEmails(
        fakeDeps({
          onQuery: (p) => {
            seen = p
          },
        }),
        { args: { limit: 20, todo }, token: 'tok' }
      )
      expect(seen?.filters).toEqual({ keywordStates: { '$label:todo': todo } })
    }
  })

  test('todo alone is enough of a filter; the schema has no type filter', () => {
    expect(selfHostedSearchEmailsInput.safeParse({ todo: true }).success).toBe(true)
    expect(selfHostedSearchEmailsInput.safeParse({}).success).toBe(false)
    const withKeywords = selfHostedSearchEmailsInput.safeParse({ keywords: ['ticket'], query: 'x' })
    expect(withKeywords.success && 'keywords' in withKeywords.data).toBe(false)
  })

  test('a cursor from a todo search does not continue the same search without it', () => {
    expect(searchFingerprint({ limit: 20, query: 'x', todo: true })).not.toBe(
      searchFingerprint({ limit: 20, query: 'x' })
    )
  })
})
