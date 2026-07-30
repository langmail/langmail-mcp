import { describe, expect, mock, test } from 'bun:test'

import { emailSubmissionCreate, identityGet } from './submission.ts'

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

const FORBIDDEN_FROM_RE = /forbiddenFrom/u

describe('identityGet', () => {
  test('declares the submission capability and asks for every identity', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.using).toContain('urn:ietf:params:jmap:submission')
      const [method, params] = body.methodCalls[0]
      expect(method).toBe('Identity/get')
      // ids: null is RFC 8620's "all of them".
      expect(params.ids).toBeNull()
      expect(params.properties).toEqual(['id', 'email', 'name', 'replyTo'])
      return Promise.resolve(
        jmapResponse([['Identity/get', { list: [{ email: 'me@example.com', id: 'i1', name: 'Me' }] }, '0']])
      )
    })
    const identities = await withFetch(f, () => identityGet(call))
    expect(identities).toEqual([{ email: 'me@example.com', id: 'i1', name: 'Me' }])
  })

  test('returns an empty list when the account has no identities', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['Identity/get', {}, '0']])))
    expect(await withFetch(f, () => identityGet(call))).toEqual([])
  })
})

describe('emailSubmissionCreate', () => {
  test('submits the email under the identity and moves it to Sent on success', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      // The mail capability rides along because onSuccessUpdateEmail is an
      // implicit Email/set.
      expect(body.using).toContain('urn:ietf:params:jmap:mail')
      expect(body.using).toContain('urn:ietf:params:jmap:submission')
      const [method, params] = body.methodCalls[0]
      expect(method).toBe('EmailSubmission/set')
      expect(params.create.send).toEqual({ emailId: 'd1', identityId: 'i1' })
      // No envelope: the server derives it from the message headers, which is
      // what gets bcc into the queue without leaking it into the delivered mail.
      expect(params.create.send.envelope).toBeUndefined()
      expect(params.onSuccessUpdateEmail['#send']).toEqual({
        'keywords/$draft': false,
        'mailboxIds/mbDrafts': null,
        'mailboxIds/mbSent': true,
      })
      return Promise.resolve(
        jmapResponse([
          [
            'EmailSubmission/set',
            { created: { send: { id: 's1', sendAt: '2026-07-30T09:00:00Z', undoStatus: 'final' } } },
            '0',
          ],
        ])
      )
    })
    const submission = await withFetch(f, () =>
      emailSubmissionCreate({
        ...call,
        draftsMailboxId: 'mbDrafts',
        emailId: 'd1',
        identityId: 'i1',
        sentMailboxId: 'mbSent',
      })
    )
    expect(submission).toEqual({ id: 's1', sendAt: '2026-07-30T09:00:00Z', undoStatus: 'final' })
  })

  test('omits the mailbox move when the account has no Sent folder', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const params = JSON.parse((init?.body as string) ?? '{}').methodCalls[0][1]
      expect(params.onSuccessUpdateEmail).toBeUndefined()
      return Promise.resolve(jmapResponse([['EmailSubmission/set', { created: { send: { id: 's1' } } }, '0']]))
    })
    await withFetch(f, () =>
      emailSubmissionCreate({ ...call, draftsMailboxId: 'mbDrafts', emailId: 'd1', identityId: 'i1' })
    )
  })

  test('throws with the JMAP error type when the submission is refused', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['EmailSubmission/set', { notCreated: { send: { description: 'nope', type: 'forbiddenFrom' } } }, '0'],
        ])
      )
    )
    await withFetch(f, async () => {
      await expect(
        emailSubmissionCreate({
          ...call,
          draftsMailboxId: 'mbDrafts',
          emailId: 'd1',
          identityId: 'i1',
          sentMailboxId: 'mbSent',
        })
      ).rejects.toThrow(FORBIDDEN_FROM_RE)
    })
  })

  test('does not leak the refusal description, which can quote the message', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          [
            'EmailSubmission/set',
            { notCreated: { send: { description: 'recipient her@example.org rejected', type: 'invalidEmail' } } },
            '0',
          ],
        ])
      )
    )
    await withFetch(f, async () => {
      const err = await emailSubmissionCreate({
        ...call,
        draftsMailboxId: 'mbDrafts',
        emailId: 'd1',
        identityId: 'i1',
        sentMailboxId: 'mbSent',
      }).catch((e: unknown) => e as Error)
      expect(err.message).toContain('invalidEmail')
      expect(err.message).not.toContain('her@example.org')
    })
  })
})
