import { describe, expect, mock, test } from 'bun:test'

import {
  emailChanges,
  emailGet,
  emailGetDetail,
  emailQuery,
  emailQueryPerTerm,
  emailSet,
  emailSetMailboxes,
  emailState,
  mailboxCreate,
  mailboxIdByName,
  mailboxIdByNameOrRole,
  mailboxIdByRole,
  mailboxIdsByRoles,
  mailboxNames,
  roleForPlaceName,
  threadEmailIds,
} from './email.ts'
import { JmapError } from './session.ts'

const API = 'https://mail.example.com/jmap/'

const withFetch = <T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const jmapResponse = (methodResponses: unknown[]) => Response.json({ methodResponses }, { status: 200 })

describe('emailQuery', () => {
  test('sends Email/query with a flat FTS filter, receivedAt-desc sort, and parses ids', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(API)
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.using).toContain('urn:ietf:params:jmap:mail')
      expect(body.methodCalls[0][0]).toBe('Email/query')
      expect(body.methodCalls[0][1].accountId).toBe('acct')
      // A single condition is passed through flat (no FilterOperator wrapper).
      expect(body.methodCalls[0][1].filter.text).toBe('hello')
      expect(body.methodCalls[0][1].limit).toBe(20)
      // We always disable totals — cheap counts on a big mailbox blow up.
      expect(body.methodCalls[0][1].calculateTotal).toBe(false)
      // Newest-first is explicit; mailbox order is wrong for date questions.
      expect(body.methodCalls[0][1].sort).toEqual([{ isAscending: false, property: 'receivedAt' }])
      return Promise.resolve(jmapResponse([['Email/query', { ids: ['e1', 'e2'] }, '0']]))
    })
    const ids = await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { text: ['hello'] },
        limit: 20,
        authorization: 'Bearer tok',
      })
    )
    expect(ids).toEqual(['e1', 'e2'])
  })

  test('AND-combines multiple scalar conditions (text + inMailbox)', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const filter = body.methodCalls[0][1].filter
      expect(filter.operator).toBe('AND')
      expect(filter.conditions).toEqual([{ text: 'hi' }, { inMailbox: 'mbx' }])
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { mailboxId: 'mbx', text: ['hi'] },
        limit: 5,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('maps date/from filters onto after/before/from conditions', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const filter = body.methodCalls[0][1].filter
      expect(filter.operator).toBe('AND')
      expect(filter.conditions).toEqual([
        { after: '2026-04-01T00:00:00Z' },
        { before: '2026-07-01T00:00:00Z' },
        { from: 'amazon' },
      ])
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { after: '2026-04-01T00:00:00Z', before: '2026-07-01T00:00:00Z', from: 'amazon' },
        limit: 5,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('a single keyword is a flat hasKeyword condition', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][1].filter).toEqual({ hasKeyword: '$label:receipt' })
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { keywords: ['$label:receipt'] },
        limit: 5,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('multiple keywords with no other filter yield a bare top-level OR node', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][1].filter).toEqual({
        conditions: [{ hasKeyword: '$label:receipt' }, { hasKeyword: '$label:newsletter' }],
        operator: 'OR',
      })
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { keywords: ['$label:receipt', '$label:newsletter'] },
        limit: 5,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('multiple keywords are OR-ed, then AND-ed with text (FilterOperator nesting)', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const filter = body.methodCalls[0][1].filter
      expect(filter.operator).toBe('AND')
      expect(filter.conditions).toEqual([
        { text: 'invoice' },
        {
          conditions: [{ hasKeyword: '$label:receipt' }, { hasKeyword: '$label:newsletter' }],
          operator: 'OR',
        },
      ])
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { keywords: ['$label:receipt', '$label:newsletter'], text: ['invoice'] },
        limit: 5,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('multiple text terms are OR-ed as separate text conditions, then AND-ed with dates', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const filter = body.methodCalls[0][1].filter
      expect(filter.operator).toBe('AND')
      expect(filter.conditions).toEqual([
        {
          conditions: [{ text: 'supabase' }, { text: 'invoice' }, { text: 'receipt' }],
          operator: 'OR',
        },
        { after: '2026-04-17T00:00:00Z' },
      ])
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { after: '2026-04-17T00:00:00Z', text: ['supabase', 'invoice', 'receipt'] },
        limit: 20,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('multiple text terms with no other filter yield a bare top-level OR node', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][1].filter).toEqual({
        conditions: [{ text: 'alpha' }, { text: 'bravo' }],
        operator: 'OR',
      })
      return Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']]))
    })
    await withFetch(f, () =>
      emailQuery({
        accountId: 'acct',
        apiUrl: API,
        filters: { text: ['alpha', 'bravo'] },
        limit: 5,
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })
})

describe('emailQueryPerTerm', () => {
  test('sends one Email/query per term in a single request, each AND-ing its term with the scalars', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls).toHaveLength(2)
      expect(body.methodCalls[0][0]).toBe('Email/query')
      expect(body.methodCalls[0][1].filter).toEqual({
        conditions: [{ text: 'supabase' }, { after: '2026-04-17T00:00:00Z' }],
        operator: 'AND',
      })
      expect(body.methodCalls[0][2]).toBe('0')
      expect(body.methodCalls[1][1].filter).toEqual({
        conditions: [{ text: 'invoice' }, { after: '2026-04-17T00:00:00Z' }],
        operator: 'AND',
      })
      expect(body.methodCalls[1][2]).toBe('1')
      // Each per-term query keeps the newest-first sort and the limit.
      expect(body.methodCalls[0][1].sort).toEqual([{ isAscending: false, property: 'receivedAt' }])
      expect(body.methodCalls[0][1].limit).toBe(20)
      return Promise.resolve(
        jmapResponse([
          ['Email/query', { ids: ['e1', 'e2'] }, '0'],
          ['Email/query', { ids: ['e2'] }, '1'],
        ])
      )
    })
    const lists = await withFetch(f, () =>
      emailQueryPerTerm({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        filters: { after: '2026-04-17T00:00:00Z' },
        limit: 20,
        terms: ['supabase', 'invoice'],
      })
    )
    expect(lists).toEqual([['e1', 'e2'], ['e2']])
  })

  test('a missing ids field in one response yields an empty list for that term', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Email/query', {}, '0'],
          ['Email/query', { ids: ['e9'] }, '1'],
        ])
      )
    )
    const lists = await withFetch(f, () =>
      emailQueryPerTerm({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        filters: {},
        limit: 5,
        terms: ['alpha', 'bravo'],
      })
    )
    expect(lists).toEqual([[], ['e9']])
  })
})

describe('emailGet', () => {
  test('requests the declared lightweight properties, attachment metadata, and returns the list', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Email/get')
      expect(body.methodCalls[0][1].ids).toEqual(['e1'])
      expect(body.methodCalls[0][1].properties).toEqual([
        'id',
        'subject',
        'from',
        'receivedAt',
        'preview',
        'mailboxIds',
        'keywords',
        'threadId',
        'hasAttachment',
        'attachments',
      ])
      expect(body.methodCalls[0][1].bodyProperties).toEqual([
        'partId',
        'blobId',
        'name',
        'type',
        'size',
        'disposition',
        'cid',
      ])
      return Promise.resolve(
        jmapResponse([
          [
            'Email/get',
            {
              list: [
                {
                  attachments: [
                    {
                      blobId: 'Gpdf',
                      cid: null,
                      disposition: 'attachment',
                      name: 'invoice.pdf',
                      partId: 'p1',
                      size: 602,
                      type: 'application/pdf',
                    },
                  ],
                  from: [{ email: 'a@x', name: 'Alice' }],
                  id: 'e1',
                  keywords: { '$label:receipt': true, $seen: true },
                  mailboxIds: { mbx: true },
                  preview: '...',
                  receivedAt: '2026-01-01T00:00:00Z',
                  subject: 'Test',
                },
              ],
            },
            '0',
          ],
        ])
      )
    })
    const out = await withFetch(f, () =>
      emailGet({
        accountId: 'acct',
        apiUrl: API,
        ids: ['e1'],
        authorization: 'Bearer tok',
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.subject).toBe('Test')
    expect(out[0]?.keywords).toEqual({ '$label:receipt': true, $seen: true })
    expect(out[0]?.attachments?.[0]?.blobId).toBe('Gpdf')
  })

  test('short-circuits with no request when ids is empty', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([])))
    const out = await withFetch(f, () =>
      emailGet({ accountId: 'acct', apiUrl: API, ids: [], authorization: 'Bearer tok' })
    )
    expect(out).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })
})

describe('emailGetDetail', () => {
  test('fetches text body values (capped) plus recipients', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const args = body.methodCalls[0][1]
      expect(args.fetchTextBodyValues).toBe(true)
      expect(args.maxBodyValueBytes).toBe(4096)
      expect(args.properties).toContain('bodyValues')
      expect(args.properties).toContain('textBody')
      expect(args.properties).toContain('to')
      expect(args.properties).toContain('attachments')
      expect(args.properties).toContain('hasAttachment')
      // Parts come back minimal and explicit: just enough to list files,
      // classify cid-inline parts, and hand back the blobId handle.
      expect(args.bodyProperties).toEqual(['partId', 'blobId', 'name', 'type', 'size', 'disposition', 'cid'])
      return Promise.resolve(
        jmapResponse([
          [
            'Email/get',
            {
              list: [
                {
                  attachments: [
                    {
                      blobId: 'Gd41d8cd',
                      cid: null,
                      disposition: 'attachment',
                      name: 'invoice.pdf',
                      partId: '2',
                      size: 186_777,
                      type: 'application/pdf',
                    },
                  ],
                  bodyValues: { '1': { value: 'hello body' } },
                  from: [{ email: 'a@x' }],
                  hasAttachment: true,
                  id: 'e1',
                  subject: 'Test',
                  textBody: [{ partId: '1', type: 'text/plain' }],
                  to: [{ email: 'b@y' }],
                },
              ],
            },
            '0',
          ],
        ])
      )
    })
    const out = await withFetch(f, () =>
      emailGetDetail({
        accountId: 'acct',
        apiUrl: API,
        ids: ['e1'],
        maxBodyValueBytes: 4096,
        authorization: 'Bearer tok',
      })
    )
    expect(out[0]?.bodyValues?.['1']?.value).toBe('hello body')
    expect(out[0]?.hasAttachment).toBe(true)
    expect(out[0]?.attachments?.[0]?.blobId).toBe('Gd41d8cd')
    expect(out[0]?.attachments?.[0]?.size).toBe(186_777)
  })

  test('requests htmlBody parts so callers can locate the HTML part blob', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const args = body.methodCalls[0][1]
      expect(args.properties).toContain('htmlBody')
      return Promise.resolve(
        jmapResponse([
          [
            'Email/get',
            {
              list: [
                {
                  htmlBody: [{ blobId: 'Ghtml1', partId: '2', size: 48_211, type: 'text/html' }],
                  id: 'e1',
                },
              ],
            },
            '0',
          ],
        ])
      )
    })
    const out = await withFetch(f, () =>
      emailGetDetail({
        accountId: 'acct',
        apiUrl: API,
        ids: ['e1'],
        maxBodyValueBytes: 4096,
        authorization: 'Bearer tok',
      })
    )
    expect(out[0]?.htmlBody?.[0]?.blobId).toBe('Ghtml1')
    expect(out[0]?.htmlBody?.[0]?.type).toBe('text/html')
  })
})

describe('threadEmailIds', () => {
  test('chains Email/get threadId into Thread/get and returns sibling ids', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Email/get')
      expect(body.methodCalls[0][1].properties).toEqual(['threadId'])
      expect(body.methodCalls[1][0]).toBe('Thread/get')
      expect(body.methodCalls[1][1]['#ids']).toEqual({
        name: 'Email/get',
        path: '/list/*/threadId',
        resultOf: '0',
      })
      return Promise.resolve(
        jmapResponse([
          ['Email/get', { list: [{ id: 'e1', threadId: 't1' }] }, '0'],
          ['Thread/get', { list: [{ emailIds: ['e1', 'e2', 'e3'], id: 't1' }] }, '1'],
        ])
      )
    })
    const ids = await withFetch(f, () =>
      threadEmailIds({ accountId: 'acct', apiUrl: API, emailId: 'e1', authorization: 'Bearer tok' })
    )
    expect(ids).toEqual(['e1', 'e2', 'e3'])
  })

  test('returns an empty array when the thread has no messages', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Email/get', { list: [] }, '0'],
          ['Thread/get', { list: [] }, '1'],
        ])
      )
    )
    const ids = await withFetch(f, () =>
      threadEmailIds({ accountId: 'acct', apiUrl: API, emailId: 'nope', authorization: 'Bearer tok' })
    )
    expect(ids).toEqual([])
  })
})

describe('mailboxIdByName', () => {
  test('returns the id of the mailbox matching by name (case-insensitive)', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Mailbox/query')
      return Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1', 'm2'] }, '0'],
          [
            'Mailbox/get',
            {
              list: [
                { id: 'm1', name: 'Inbox' },
                { id: 'm2', name: 'Sent' },
              ],
            },
            '1',
          ],
        ])
      )
    })
    const id = await withFetch(f, () =>
      mailboxIdByName({
        accountId: 'acct',
        apiUrl: API,
        name: 'inbox',
        authorization: 'Bearer tok',
      })
    )
    expect(id).toBe('m1')
  })

  test('returns null when no mailbox matches', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: [] }, '0'],
          ['Mailbox/get', { list: [] }, '1'],
        ])
      )
    )
    const id = await withFetch(f, () =>
      mailboxIdByName({
        accountId: 'acct',
        apiUrl: API,
        name: 'Nope',
        authorization: 'Bearer tok',
      })
    )
    expect(id).toBeNull()
  })
})

describe('mailboxIdByRole', () => {
  test('matches on the special-use role, not the display name', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      // role must be requested so the match has something to compare against.
      expect(body.methodCalls[1][1].properties).toContain('role')
      return Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1', 'm2'] }, '0'],
          [
            'Mailbox/get',
            {
              list: [
                { id: 'm1', name: 'Posteingang', role: 'inbox' },
                { id: 'm2', name: 'Archiv', role: 'archive' },
              ],
            },
            '1',
          ],
        ])
      )
    })
    const id = await withFetch(f, () =>
      mailboxIdByRole({ accountId: 'acct', apiUrl: API, role: 'inbox', authorization: 'Bearer tok' })
    )
    expect(id).toBe('m1')
  })

  test('returns null when no mailbox carries the role', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1'] }, '0'],
          ['Mailbox/get', { list: [{ id: 'm1', name: 'Inbox', role: null }] }, '1'],
        ])
      )
    )
    const id = await withFetch(f, () =>
      mailboxIdByRole({ accountId: 'acct', apiUrl: API, role: 'archive', authorization: 'Bearer tok' })
    )
    expect(id).toBeNull()
  })
})

describe('roleForPlaceName', () => {
  test('maps the standard places and their obvious synonyms', () => {
    expect(roleForPlaceName('Sent')).toBe('sent')
    expect(roleForPlaceName('  inbox ')).toBe('inbox')
    expect(roleForPlaceName('Spam')).toBe('junk')
    expect(roleForPlaceName('Bin')).toBe('trash')
  })

  test('an ordinary folder name is not a place', () => {
    expect(roleForPlaceName('Receipts')).toBeUndefined()
  })
})

describe('mailboxIdByNameOrRole', () => {
  // The account shape that produced the bug: a stock Stalwart mailbox whose
  // sent folder is named "Sent Items", so a name-only lookup for "Sent" misses
  // the folder the Gmail projection actually files sent mail into.
  const stalwartDefaults = (): ReturnType<typeof mock> =>
    mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1', 'm2', 'm3'] }, '0'],
          [
            'Mailbox/get',
            {
              list: [
                { id: 'm1', name: 'Inbox', role: 'inbox' },
                { id: 'm2', name: 'Sent Items', role: 'sent' },
                { id: 'm3', name: 'Receipts', role: null },
              ],
            },
            '1',
          ],
        ])
      )
    )

  const resolve = (name: string): Promise<string | null> =>
    withFetch(stalwartDefaults(), () =>
      mailboxIdByNameOrRole({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', name })
    )

  test('falls back to the role when no folder carries the place name', async () => {
    // Regression: this returned null, and the caller reported the user's synced
    // sent mail as a missing mailbox.
    expect(await resolve('Sent')).toBe('m2')
  })

  test('resolves a place whose name and role agree', async () => {
    expect(await resolve('Inbox')).toBe('m1')
  })

  test('a non-place name resolves by its literal name', async () => {
    // "Sent Items" is not a place name, so it can only match by name.
    expect(await resolve('Sent Items')).toBe('m2')
  })

  test('a stray folder named for a place does not shadow the role mailbox', async () => {
    // The mail-rules `resolveMailboxByName` used to create exactly this: an
    // empty, role-less "Sent" beside the role-bearing "Sent Items". Matching it
    // by name would return zero hits and read as "sent mail was never synced".
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1', 'm2'] }, '0'],
          [
            'Mailbox/get',
            {
              list: [
                { id: 'm1', name: 'Sent', role: null },
                { id: 'm2', name: 'Sent Items', role: 'sent' },
              ],
            },
            '1',
          ],
        ])
      )
    )
    const id = await withFetch(f, () =>
      mailboxIdByNameOrRole({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', name: 'Sent' })
    )
    expect(id).toBe('m2')
  })

  test('resolves an ordinary folder by name', async () => {
    expect(await resolve('receipts')).toBe('m3')
  })

  test('returns null for a name that is neither a folder nor a place', async () => {
    expect(await resolve('DoesNotExist')).toBeNull()
  })

  test('returns null for a place with neither a role mailbox nor a matching name', async () => {
    expect(await resolve('Archive')).toBeNull()
  })

  test('a place falls back to its name when no mailbox carries the role', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1'] }, '0'],
          ['Mailbox/get', { list: [{ id: 'm1', name: 'Archive', role: null }] }, '1'],
        ])
      )
    )
    const id = await withFetch(f, () =>
      mailboxIdByNameOrRole({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', name: 'Archive' })
    )
    expect(id).toBe('m1')
  })

  test('resolves both lookups from a single listing round-trip', async () => {
    const f = stalwartDefaults()
    await withFetch(f, () =>
      mailboxIdByNameOrRole({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', name: 'Sent' })
    )
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('mailboxNames', () => {
  test('lists every folder name in the account', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1', 'm2'] }, '0'],
          [
            'Mailbox/get',
            {
              list: [
                { id: 'm1', name: 'Inbox', role: 'inbox' },
                { id: 'm2', name: 'Sent Items', role: 'sent' },
              ],
            },
            '1',
          ],
        ])
      )
    )
    const names = await withFetch(f, () =>
      mailboxNames({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' })
    )
    expect(names).toEqual(['Inbox', 'Sent Items'])
  })
})

describe('mailboxIdsByRoles', () => {
  test('resolves several roles from a single mailbox listing', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Mailbox/query', { ids: ['m1', 'm2'] }, '0'],
          [
            'Mailbox/get',
            {
              list: [
                { id: 'm1', name: 'Inbox', role: 'inbox' },
                { id: 'm2', name: 'Sent', role: 'sent' },
              ],
            },
            '1',
          ],
        ])
      )
    )
    const ids = await withFetch(f, () =>
      mailboxIdsByRoles({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        roles: ['inbox', 'archive'],
      })
    )
    expect(ids).toEqual({ archive: null, inbox: 'm1' })
    // One listing round-trip for all roles.
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('mailboxCreate', () => {
  test('creates a mailbox with name + role and returns its id', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Mailbox/set')
      expect(body.methodCalls[0][1].create).toEqual({ m0: { name: 'Archive', role: 'archive' } })
      return Promise.resolve(jmapResponse([['Mailbox/set', { created: { m0: { id: 'mbx-arch' } } }, '0']]))
    })
    const id = await withFetch(f, () =>
      mailboxCreate({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', name: 'Archive', role: 'archive' })
    )
    expect(id).toBe('mbx-arch')
  })

  test('throws JmapError when the server reports notCreated', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['Mailbox/set', { notCreated: { m0: { type: 'forbidden' } } }, '0']]))
    )
    await withFetch(f, async () => {
      const err = await mailboxCreate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        name: 'Archive',
        role: 'archive',
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as Error).message).toContain('forbidden')
    })
  })
})

describe('emailSet', () => {
  test('sends a JSON-pointer keyword+mailbox patch and resolves on updated', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Email/set')
      const update = body.methodCalls[0][1].update
      // Keyword add stays boolean; mailbox removal is the RFC-canonical null.
      expect(update).toEqual({
        e1: {
          'keywords/$label:receipt': true,
          'mailboxIds/mbx-inbox': null,
        },
      })
      return Promise.resolve(jmapResponse([['Email/set', { updated: { e1: null } }, '0']]))
    })
    await withFetch(f, () =>
      emailSet({
        accountId: 'acct',
        apiUrl: API,
        changes: { keywords: { '$label:receipt': true }, mailboxIds: { 'mbx-inbox': false } },
        id: 'e1',
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('escapes ~ and / in keyword pointer tokens (RFC 6901)', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][1].update.e1).toEqual({
        'keywords/$label:travel~1asia~0x': true,
      })
      return Promise.resolve(jmapResponse([['Email/set', { updated: { e1: null } }, '0']]))
    })
    await withFetch(f, () =>
      emailSet({
        accountId: 'acct',
        apiUrl: API,
        changes: { keywords: { '$label:travel/asia~x': true } },
        id: 'e1',
        authorization: 'Bearer tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('throws JmapError when the id lands in notUpdated', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['Email/set', { notUpdated: { e1: { type: 'notFound' } } }, '0']]))
    )
    await withFetch(f, async () => {
      const err = await emailSet({
        accountId: 'acct',
        apiUrl: API,
        changes: { keywords: { '$label:receipt': true } },
        id: 'e1',
        authorization: 'Bearer tok',
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as Error).message).toContain('notFound')
    })
  })
})

describe('emailChanges', () => {
  test('sends sinceState + maxChanges and normalizes the delta', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Email/changes')
      expect(body.methodCalls[0][1].sinceState).toBe('s0')
      expect(body.methodCalls[0][1].maxChanges).toBe(50)
      return Promise.resolve(
        jmapResponse([
          [
            'Email/changes',
            { created: ['e1'], destroyed: [], hasMoreChanges: true, newState: 's1', oldState: 's0', updated: ['e2'] },
            '0',
          ],
        ])
      )
    })
    const out = await withFetch(f, () =>
      emailChanges({ accountId: 'acct', apiUrl: API, maxChanges: 50, sinceState: 's0', authorization: 'Bearer tok' })
    )
    expect(out).toEqual({
      created: ['e1'],
      destroyed: [],
      hasMoreChanges: true,
      newState: 's1',
      oldState: 's0',
      updated: ['e2'],
    })
  })

  test('omits maxChanges when unset and fills sensible defaults', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect('maxChanges' in body.methodCalls[0][1]).toBe(false)
      // A minimal server response still yields a well-formed result: the
      // cursor stays put (newState falls back to sinceState) and lists empty.
      return Promise.resolve(jmapResponse([['Email/changes', {}, '0']]))
    })
    const out = await withFetch(f, () =>
      emailChanges({ accountId: 'acct', apiUrl: API, sinceState: 's0', authorization: 'Bearer tok' })
    )
    expect(out).toEqual({
      created: [],
      destroyed: [],
      hasMoreChanges: false,
      newState: 's0',
      oldState: 's0',
      updated: [],
    })
  })
})

describe('emailState', () => {
  test('fetches the current Email state via an empty Email/get', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][0]).toBe('Email/get')
      expect(body.methodCalls[0][1].ids).toEqual([])
      return Promise.resolve(jmapResponse([['Email/get', { list: [], state: 's42' }, '0']]))
    })
    const state = await withFetch(f, () => emailState({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' }))
    expect(state).toBe('s42')
  })

  test('throws when the server omits the state', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['Email/get', { list: [] }, '0']])))
    await expect(
      withFetch(f, () => emailState({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' }))
    ).rejects.toThrow(JmapError)
  })

  test('surfaces an RFC 8620 error method response as a typed JmapError', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['error', { type: 'cannotCalculateChanges' }, '0']])))
    try {
      await withFetch(f, () =>
        emailChanges({ accountId: 'acct', apiUrl: API, sinceState: 's0', authorization: 'Bearer tok' })
      )
      throw new Error('expected emailChanges to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).errorType).toBe('cannotCalculateChanges')
    }
  })
})

describe('emailSetMailboxes', () => {
  test('sends the whole mailboxIds property per id and reports per-id outcome', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(API)
      const body = JSON.parse(String(init?.body))
      expect(body.methodCalls[0][0]).toBe('Email/set')
      expect(body.methodCalls[0][1].accountId).toBe('a1')
      expect(body.methodCalls[0][1].update).toEqual({
        e1: { mailboxIds: { mb9: true } },
        e2: { mailboxIds: { mb9: true } },
      })
      return Promise.resolve(
        jmapResponse([['Email/set', { notUpdated: { e2: { type: 'notFound' } }, updated: { e1: null } }, '0']])
      )
    })
    const result = await withFetch(f, () =>
      emailSetMailboxes({
        accountId: 'a1',
        apiUrl: API,
        authorization: 'Bearer t',
        ids: ['e1', 'e2'],
        mailboxId: 'mb9',
      })
    )
    expect(result).toEqual({ notUpdated: [{ id: 'e2', type: 'notFound' }], updated: ['e1'] })
  })

  test('is a no-op for an empty id list', async () => {
    const f = mock(() => Promise.reject(new Error('must not call')))
    const result = await withFetch(f, () =>
      emailSetMailboxes({ accountId: 'a1', apiUrl: API, authorization: 'Bearer t', ids: [], mailboxId: 'mb9' })
    )
    expect(result).toEqual({ notUpdated: [], updated: [] })
    expect(f).not.toHaveBeenCalled()
  })
})
