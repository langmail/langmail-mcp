import { describe, expect, test } from 'bun:test'

import { type DraftCreateParams, type EmailSubmissionCreateParams } from '@langmail/jmap'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { type DraftDepsOptions, draftDeps, receivedMessage, TEST_PRINCIPAL } from './draft-test-fixtures.ts'
import { replyArgsError, replyToMessage, replyToMessageInput } from './reply-to-message.ts'

const store = () => createIdempotencyStore<string>()

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await replyToMessage(draftDeps(opts), store(), {
    args: replyToMessageInput.parse(args),
    principal: TEST_PRINCIPAL,
    token: 'tok',
  })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('replyArgsError', () => {
  test('rejects replyAll combined with any explicit recipient field', () => {
    for (const override of [{ to: ['a@example.org'] }, { cc: ['a@example.org'] }, { bcc: ['a@example.org'] }]) {
      const args = replyToMessageInput.parse({ messageId: 'e1', replyAll: true, text: 'hi', ...override })
      expect(replyArgsError(args)).toContain('replyAll cannot be combined')
    }
  })

  test('accepts replyAll alone and explicit recipients alone', () => {
    expect(replyArgsError(replyToMessageInput.parse({ messageId: 'e1', replyAll: true, text: 'hi' }))).toBeNull()
    expect(replyArgsError(replyToMessageInput.parse({ messageId: 'e1', text: 'hi', to: ['a@example.org'] }))).toBeNull()
  })

  test('requires a body', () => {
    expect(replyArgsError(replyToMessageInput.parse({ messageId: 'e1' }))).toContain('Provide a body')
  })
})

describe('replyToMessage', () => {
  test('stages a threaded reply and sends it in one call', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const { text } = await run(
      { messageId: 'e1', text: 'Thanks — looks right.' },
      { creates, records: { e1: receivedMessage() }, submissions }
    )

    // The reply is written as a draft first, so a failed submission leaves
    // something recoverable rather than nothing.
    expect(creates).toHaveLength(1)
    const draft = creates[0]?.draft
    expect(draft?.to).toEqual([{ email: 'nadia@example.org', name: 'Nadia Bram' }])
    expect(draft?.subject).toBe('Re: Quarterly numbers')
    expect(draft?.inReplyTo).toEqual(['orig@example.org'])
    expect(draft?.from).toEqual([{ email: TEST_PRINCIPAL, name: 'Dana Okonjo' }])

    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.emailId).toBe('dNew')
    expect(text).toContain('Reply sent.')
    expect(text).toContain('messageId: dNew')
  })

  test('reply-all includes the original roster minus the user', async () => {
    const creates: DraftCreateParams[] = []
    await run({ messageId: 'e1', replyAll: true, text: 'Thanks!' }, { creates, records: { e1: receivedMessage() } })
    const recipients = [...(creates[0]?.draft.to ?? []), ...(creates[0]?.draft.cc ?? [])]
    expect(recipients.map((a) => a.email)).toEqual(['nadia@example.org', 'tomas@example.com', 'carl@example.org'])
  })

  test('rejects replyAll with recipient overrides before anything is staged or sent', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const { result, text } = await run(
      { cc: ['carl@example.org'], messageId: 'e1', replyAll: true, text: 'hi' },
      { creates, records: { e1: receivedMessage() }, submissions }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('Nothing was sent')
    expect(creates).toEqual([])
    expect(submissions).toEqual([])
  })

  test('refuses to reply to a message that does not exist', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { result, text } = await run({ messageId: 'gone', text: 'hi' }, { submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('message not found')
    expect(submissions).toEqual([])
  })

  test('refuses when the original has nobody to reply to', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const bare = receivedMessage({ cc: [], from: [], to: [] })
    const { result, text } = await run({ messageId: 'e1', text: 'hi' }, { records: { e1: bare }, submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('no sender address to reply to')
    expect(submissions).toEqual([])
  })

  test('replays a repeated idempotencyKey instead of sending a second reply', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const replays = store()
    const deps = draftDeps({ creates, records: { e1: receivedMessage() }, submissions })
    const ctx = {
      args: replyToMessageInput.parse({ idempotencyKey: 'k1', messageId: 'e1', text: 'hi' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }

    await replyToMessage(deps, replays, ctx)
    const second = await replyToMessage(deps, replays, ctx)

    expect(creates).toHaveLength(1)
    expect(submissions).toHaveLength(1)
    expect(second.content[0]?.text).toContain('no second reply was sent')
  })

  test('falls back to the original thread when the new draft reports none', async () => {
    const { text } = await run(
      { messageId: 'e1', text: 'hi' },
      { created: { id: 'dNew', threadId: null }, records: { e1: receivedMessage() } }
    )
    expect(text).toContain('threadId: t1')
  })
})
