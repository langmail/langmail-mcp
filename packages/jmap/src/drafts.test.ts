import { describe, expect, mock, test } from 'bun:test'

import { draftCreate, emailComposeGet, sentEmailPatch } from './drafts.ts'
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

const call = { accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' }

const INVALID_PROPERTIES_RE = /invalidProperties/u

describe('draftCreate', () => {
  test('files a text draft into the given mailbox with the $draft keyword', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(API)
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.using).toContain('urn:ietf:params:jmap:mail')
      const [method, params] = body.methodCalls[0]
      expect(method).toBe('Email/set')
      const draft = params.create.draft
      expect(draft.mailboxIds).toEqual({ mbDrafts: true })
      // $draft is what marks it unsent; $seen keeps it out of the unread count.
      expect(draft.keywords).toEqual({ $draft: true, $seen: true })
      expect(draft.from).toEqual([{ email: 'me@example.com', name: 'Me' }])
      expect(draft.to).toEqual([{ email: 'her@example.org' }])
      expect(draft.subject).toBe('Hello')
      // The body rides as a bodyValues entry the textBody part points at.
      expect(draft.textBody).toEqual([{ partId: 'text', type: 'text/plain' }])
      expect(draft.bodyValues).toEqual({ text: { value: 'Body here' } })
      expect(draft.htmlBody).toBeUndefined()
      // No replacement requested, so nothing is destroyed.
      expect(params.destroy).toBeUndefined()
      return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1', threadId: 't1' } } }, '0']]))
    })
    const result = await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: {
          from: [{ email: 'me@example.com', name: 'Me' }],
          subject: 'Hello',
          text: 'Body here',
          to: [{ email: 'her@example.org' }],
        },
        mailboxId: 'mbDrafts',
      })
    )
    expect(result).toEqual({ id: 'd1', threadId: 't1' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('sends both body parts when text and html are given', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const draft = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1].create.draft
      expect(draft.textBody).toEqual([{ partId: 'text', type: 'text/plain' }])
      expect(draft.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }])
      expect(draft.bodyValues).toEqual({ html: { value: '<p>hi</p>' }, text: { value: 'hi' } })
      return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
    })
    await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { from: [{ email: 'me@example.com' }], html: '<p>hi</p>', text: 'hi' },
        mailboxId: 'mbDrafts',
      })
    )
  })

  test('carries the threading headers as bare message ids', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const draft = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1].create.draft
      expect(draft.inReplyTo).toEqual(['orig@example.org'])
      expect(draft.references).toEqual(['first@example.org', 'orig@example.org'])
      return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
    })
    await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: {
          from: [{ email: 'me@example.com' }],
          inReplyTo: ['orig@example.org'],
          references: ['first@example.org', 'orig@example.org'],
          text: 'ok',
        },
        mailboxId: 'mbDrafts',
      })
    )
  })

  test('replaces a draft by creating and destroying in one Email/set', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      // One call — RFC 8620 orders create before destroy, so the edit is never
      // visible as two drafts and can't lose the old one on a failed create.
      expect(params.create.draft).toBeDefined()
      expect(params.destroy).toEqual(['d0'])
      return Promise.resolve(
        jmapResponse([['Email/set', { created: { draft: { id: 'd1' } }, destroyed: ['d0'] }, '0']])
      )
    })
    const result = await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { from: [{ email: 'me@example.com' }], text: 'edited' },
        mailboxId: 'mbDrafts',
        replaces: 'd0',
      })
    )
    expect(result).toEqual({ id: 'd1', replacedDestroyed: true, threadId: null })
  })

  test('reports a replacement whose destroy did not land', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } }, destroyed: [] }, '0']]))
    )
    const result = await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { from: [{ email: 'me@example.com' }], text: 'edited' },
        mailboxId: 'mbDrafts',
        replaces: 'd0',
      })
    )
    expect(result.replacedDestroyed).toBe(false)
  })

  test('throws with the JMAP error type when the create is refused', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['Email/set', { notCreated: { draft: { type: 'invalidProperties' } } }, '0']]))
    )
    await withFetch(f, async () => {
      await expect(
        draftCreate({
          ...call,
          draft: { from: [{ email: 'me@example.com' }], text: 'x' },
          mailboxId: 'mbDrafts',
        })
      ).rejects.toThrow(INVALID_PROPERTIES_RE)
    })
  })
})

describe('emailComposeGet', () => {
  test('requests bcc and the threading headers, and fetches both body parts', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      expect(params.ids).toEqual(['d1'])
      expect(params.properties).toContain('bcc')
      expect(params.properties).toContain('inReplyTo')
      expect(params.properties).toContain('references')
      expect(params.properties).toContain('htmlBody')
      // fetchAllBodyValues, not fetchTextBodyValues: an html-only draft would
      // otherwise read back with an empty body.
      expect(params.fetchAllBodyValues).toBe(true)
      expect(params.maxBodyValueBytes).toBe(1000)
      expect(params.bodyProperties).toContain('type')
      return Promise.resolve(jmapResponse([['Email/get', { list: [{ id: 'd1' }] }, '0']]))
    })
    const record = await withFetch(f, () => emailComposeGet({ ...call, id: 'd1', maxBodyValueBytes: 1000 }))
    expect(record?.id).toBe('d1')
  })

  test('returns null for an id the server does not know', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['Email/get', { list: [], notFound: ['nope'] }, '0']])))
    const record = await withFetch(f, () => emailComposeGet({ ...call, id: 'nope', maxBodyValueBytes: 1000 }))
    expect(record).toBeNull()
  })

  test('surfaces a method-level JMAP error rather than a null record', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['error', { type: 'accountNotFound' }, '0']])))
    await withFetch(f, async () => {
      await expect(emailComposeGet({ ...call, id: 'd1', maxBodyValueBytes: 1000 })).rejects.toBeInstanceOf(JmapError)
    })
  })
})

describe('sentEmailPatch', () => {
  test('moves the message out of Drafts into Sent and clears $draft', () => {
    expect(sentEmailPatch('mbDrafts', 'mbSent')).toEqual({
      // `false` removes a keyword (email-sync's production-proven convention);
      // `null` removes a mailbox (the RFC 8620 canonical PatchObject removal).
      'keywords/$draft': false,
      'mailboxIds/mbDrafts': null,
      'mailboxIds/mbSent': true,
    })
  })

  test('escapes JSON Pointer metacharacters in mailbox ids', () => {
    const patch = sentEmailPatch('a/b', 'c~d')
    expect(patch['mailboxIds/a~1b']).toBeNull()
    expect(patch['mailboxIds/c~0d']).toBe(true)
  })
})
