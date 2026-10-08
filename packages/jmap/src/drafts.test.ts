import { describe, expect, mock, test } from 'bun:test'

import { draftCreate, draftIdResolve, emailComposeGet, sentEmailPatch, threadMessageFind } from './drafts.ts'
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
const OVER_QUOTA_RE = /overQuota/u

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

  test('references attachment blobs as body parts, and drops the read-back size', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const draft = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1].create.draft
      expect(draft.attachments).toEqual([
        // `disposition` is explicit — it is what decides whether the recipient's
        // client offers the part as a file or renders it in place.
        { blobId: 'Ginvoice', disposition: 'attachment', name: 'invoice.pdf', type: 'application/pdf' },
        // A part the HTML body points at is inline by definition.
        { blobId: 'Glogo', cid: 'logo@langmail', disposition: 'inline', name: 'logo.png', type: 'image/png' },
        // No name and no type given: the wire still needs a media type.
        { blobId: 'Gbare', disposition: 'attachment', type: 'application/octet-stream' },
      ])
      // `size` exists only so a stored draft can be read back — the server
      // computes the part's size from the blob, so sending it back is noise.
      expect(JSON.stringify(draft.attachments)).not.toContain('size')
      return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
    })
    await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: {
          attachments: [
            { blobId: 'Ginvoice', name: 'invoice.pdf', size: 1024, type: 'application/pdf' },
            { blobId: 'Glogo', cid: 'logo@langmail', name: 'logo.png', type: 'image/png' },
            { blobId: 'Gbare' },
          ],
          from: [{ email: 'me@example.com' }],
          text: 'See attached.',
        },
        mailboxId: 'mbDrafts',
      })
    )
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('keeps a stored disposition instead of re-deriving it from the cid', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const draft = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1].create.draft
      expect(draft.attachments).toEqual([
        // A plain attachment may well carry a Content-ID. Inferring from the cid
        // would flip it to inline, and the recipient's client would try to
        // render a document in the body instead of offering it as a download.
        { blobId: 'Gdoc', cid: 'doc@example', disposition: 'attachment', name: 'report.pdf', type: 'application/pdf' },
        // The mirror: inline with no cid stays inline rather than becoming a file.
        { blobId: 'Gart', disposition: 'inline', name: 'art.png', type: 'image/png' },
        // Content-Location is the other way an HTML body resolves an inline
        // resource; dropping it would leave the unchanged HTML pointing nowhere.
        {
          blobId: 'Gbg',
          disposition: 'inline',
          location: 'https://example.com/bg.png',
          name: 'bg.png',
          type: 'image/png',
        },
      ])
      return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
    })
    await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: {
          attachments: [
            {
              blobId: 'Gdoc',
              cid: 'doc@example',
              disposition: 'attachment',
              name: 'report.pdf',
              type: 'application/pdf',
            },
            { blobId: 'Gart', disposition: 'inline', name: 'art.png', type: 'image/png' },
            {
              blobId: 'Gbg',
              disposition: 'inline',
              location: 'https://example.com/bg.png',
              name: 'bg.png',
              type: 'image/png',
            },
          ],
          from: [{ email: 'me@example.com' }],
          text: 'See attached.',
        },
        mailboxId: 'mbDrafts',
      })
    )
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('omits the attachments property entirely when there are none', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const draft = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1].create.draft
      // An empty list is how update_draft spells "the user removed the files",
      // and the absent property is the canonical form of that on a create.
      expect(draft).not.toHaveProperty('attachments')
      return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
    })
    await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { attachments: [], from: [{ email: 'me@example.com' }], text: 'hi' },
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

  test('destroys the replaced draft only after the new one exists', async () => {
    const calls: Record<string, unknown>[] = []
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      calls.push(params)
      return Promise.resolve(
        params.create
          ? jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']])
          : jmapResponse([['Email/set', { destroyed: ['d0'] }, '0']])
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
    // Two round trips, in this order. Batching them would let a rejected create
    // destroy the draft anyway — Foo/set is not a transaction (RFC 8620 §5.3).
    expect(calls).toHaveLength(2)
    expect(calls[0]?.create).toBeDefined()
    expect(calls[0]?.destroy).toBeUndefined()
    expect(calls[1]?.destroy).toEqual(['d0'])
    expect(result).toEqual({ id: 'd1', replacedDestroyed: true, threadId: null })
  })

  test('leaves the replaced draft alone when the create is refused', async () => {
    const calls: Record<string, unknown>[] = []
    const f = mock((_url: string, init?: RequestInit) => {
      calls.push(JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1])
      return Promise.resolve(jmapResponse([['Email/set', { notCreated: { draft: { type: 'overQuota' } } }, '0']]))
    })
    await withFetch(f, async () => {
      await expect(
        draftCreate({
          ...call,
          draft: { from: [{ email: 'me@example.com' }], text: 'edited' },
          mailboxId: 'mbDrafts',
          replaces: 'd0',
        })
      ).rejects.toThrow(OVER_QUOTA_RE)
    })
    // The user's staged message must survive a failed edit — no destroy was sent.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.destroy).toBeUndefined()
  })

  test('keeps the new draft id when the destroy request itself throws', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      if (params.create) {
        return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
      }
      return Promise.reject(new Error('socket hang up'))
    })
    const result = await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { from: [{ email: 'me@example.com' }], text: 'edited' },
        mailboxId: 'mbDrafts',
        replaces: 'd0',
      })
    )
    // Throwing here would discard the id of a draft that already exists, and the
    // caller — told only that the edit failed — would retry against the old id
    // and pile up more drafts.
    expect(result.id).toBe('d1')
    expect(result.replacedDestroyed).toBe(false)
  })

  test('reports a replacement whose destroy did not land', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      return Promise.resolve(
        params.create
          ? jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']])
          : jmapResponse([['Email/set', { destroyed: [] }, '0']])
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
    expect(result.replacedDestroyed).toBe(false)
  })

  test('takes the draft id off a superseded draft the destroy left behind', async () => {
    const calls: Record<string, unknown>[] = []
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      calls.push(params)
      if (params.create) {
        return Promise.resolve(jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']]))
      }
      return Promise.resolve(
        jmapResponse([['Email/set', params.destroy ? { destroyed: [] } : { updated: { d0: null } }, '0']])
      )
    })
    const result = await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { from: [{ email: 'me@example.com' }], text: 'edited' },
        keywords: ['$label:invoices', '$draftid:tok1'],
        mailboxId: 'mbDrafts',
        replaces: 'd0',
      })
    )
    expect(result.replacedDestroyed).toBe(false)
    // Only the draft id goes: the token must name the replacement alone, while
    // the stale copy keeps its labels and stays a draft the user can delete.
    expect(calls[2]).toEqual({ accountId: 'acct', update: { d0: { 'keywords/$draftid:tok1': false } } })
  })

  test('does not touch a superseded draft that was destroyed', async () => {
    const calls: Record<string, unknown>[] = []
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      calls.push(params)
      return Promise.resolve(
        params.create
          ? jmapResponse([['Email/set', { created: { draft: { id: 'd1' } } }, '0']])
          : jmapResponse([['Email/set', { destroyed: ['d0'] }, '0']])
      )
    })
    await withFetch(f, () =>
      draftCreate({
        ...call,
        draft: { from: [{ email: 'me@example.com' }], text: 'edited' },
        keywords: ['$draftid:tok1'],
        mailboxId: 'mbDrafts',
        replaces: 'd0',
      })
    )
    expect(calls).toHaveLength(2)
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
      // Everything a rewrite has to put back on an attachment part. Carrying
      // these through `attachmentPart` is useless if they were never read, and
      // that half of the round trip is invisible from the write side.
      for (const property of ['blobId', 'disposition', 'cid', 'location', 'name', 'size']) {
        expect(params.bodyProperties).toContain(property)
      }
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

describe('draftIdResolve', () => {
  test('queries the $draftid: keyword newest first and returns the hit', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const [method, params] = JSON.parse((init?.body as string) ?? '{}').methodCalls[0]
      expect(method).toBe('Email/query')
      expect(params.filter).toEqual({ hasKeyword: '$draftid:d1' })
      expect(params.sort).toEqual([{ isAscending: false, property: 'receivedAt' }])
      expect(params.limit).toBe(1)
      return Promise.resolve(jmapResponse([['Email/query', { ids: ['d3'] }, '0']]))
    })
    expect(await withFetch(f, () => draftIdResolve({ ...call, draftId: 'd1' }))).toBe('d3')
  })

  test('returns null when no message carries the keyword', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['Email/query', { ids: [] }, '0']])))
    expect(await withFetch(f, () => draftIdResolve({ ...call, draftId: 'd1' }))).toBeNull()
  })
})

describe('threadMessageFind', () => {
  test('reads the thread by back-reference and matches the Message-ID', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const calls = JSON.parse((init?.body as string) ?? '{}').methodCalls
      expect(calls.map(([method]: [string]) => method)).toEqual(['Email/get', 'Thread/get', 'Email/get'])
      expect(calls[0][1].ids).toEqual(['d1'])
      expect(calls[2][1]['#ids']).toEqual({ name: 'Thread/get', path: '/list/*/emailIds', resultOf: '1' })
      return Promise.resolve(
        jmapResponse([
          ['Email/get', { list: [{ id: 'd1', threadId: 't1' }] }, '0'],
          ['Thread/get', { list: [{ emailIds: ['e1', 'd1'], id: 't1' }] }, '1'],
          [
            'Email/get',
            {
              list: [
                { id: 'e1', messageId: ['orig@example.org'] },
                { id: 'd1', messageId: ['draft@langmail.me'] },
              ],
            },
            '2',
          ],
        ])
      )
    })
    const found = await withFetch(f, () => threadMessageFind({ ...call, emailId: 'd1', messageId: 'orig@example.org' }))
    expect(found).toBe('e1')
  })

  test('returns null when no message in the thread has that Message-ID', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['Email/get', { list: [{ id: 'd1', threadId: 't1' }] }, '0'],
          ['Thread/get', { list: [{ emailIds: ['d1'], id: 't1' }] }, '1'],
          ['Email/get', { list: [{ id: 'd1', messageId: ['draft@langmail.me'] }] }, '2'],
        ])
      )
    )
    const found = await withFetch(f, () => threadMessageFind({ ...call, emailId: 'd1', messageId: 'orig@example.org' }))
    expect(found).toBeNull()
  })
})
