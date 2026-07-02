import { describe, expect, mock, test } from 'bun:test'

import {
  emailChanges,
  emailGet,
  emailGetDetail,
  emailQuery,
  emailSet,
  mailboxIdByName,
  mailboxIdByRole,
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
        filters: { text: 'hello' },
        limit: 20,
        token: 'tok',
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
        filters: { mailboxId: 'mbx', text: 'hi' },
        limit: 5,
        token: 'tok',
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
        token: 'tok',
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
        token: 'tok',
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
        token: 'tok',
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
        filters: { keywords: ['$label:receipt', '$label:newsletter'], text: 'invoice' },
        limit: 5,
        token: 'tok',
      })
    )
    expect(f).toHaveBeenCalled()
  })
})

describe('emailGet', () => {
  test('requests the declared lightweight properties (incl. keywords) and returns the list', async () => {
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
      ])
      return Promise.resolve(
        jmapResponse([
          [
            'Email/get',
            {
              list: [
                {
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
        token: 'tok',
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.subject).toBe('Test')
    expect(out[0]?.keywords).toEqual({ '$label:receipt': true, $seen: true })
  })

  test('short-circuits with no request when ids is empty', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([])))
    const out = await withFetch(f, () => emailGet({ accountId: 'acct', apiUrl: API, ids: [], token: 'tok' }))
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
      return Promise.resolve(
        jmapResponse([
          [
            'Email/get',
            {
              list: [
                {
                  bodyValues: { '1': { value: 'hello body' } },
                  from: [{ email: 'a@x' }],
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
      emailGetDetail({ accountId: 'acct', apiUrl: API, ids: ['e1'], maxBodyValueBytes: 4096, token: 'tok' })
    )
    expect(out[0]?.bodyValues?.['1']?.value).toBe('hello body')
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
      threadEmailIds({ accountId: 'acct', apiUrl: API, emailId: 'e1', token: 'tok' })
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
      threadEmailIds({ accountId: 'acct', apiUrl: API, emailId: 'nope', token: 'tok' })
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
        token: 'tok',
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
        token: 'tok',
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
      mailboxIdByRole({ accountId: 'acct', apiUrl: API, role: 'inbox', token: 'tok' })
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
      mailboxIdByRole({ accountId: 'acct', apiUrl: API, role: 'archive', token: 'tok' })
    )
    expect(id).toBeNull()
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
        token: 'tok',
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
        token: 'tok',
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
        changes: { keywords: { '$label:ai': true } },
        id: 'e1',
        token: 'tok',
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
      emailChanges({ accountId: 'acct', apiUrl: API, maxChanges: 50, sinceState: 's0', token: 'tok' })
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
      emailChanges({ accountId: 'acct', apiUrl: API, sinceState: 's0', token: 'tok' })
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
