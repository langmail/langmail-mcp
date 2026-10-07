import { describe, expect, spyOn, test } from 'bun:test'

import { type DraftCreateParams, type EmailSubmissionCreateParams, JmapError } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import {
  type DraftDepsOptions,
  draftDeps,
  gate,
  receivedMessage,
  settle,
  stagedDraft,
  TEST_PRINCIPAL,
} from './draft-test-fixtures.ts'
import { replyArgsError, replyToMessage, replyToMessageInput } from './reply-to-message.ts'
import { sendDraft, sendDraftInput } from './send-draft.ts'

const store = () => createIdempotencyStore<string>()

// A failed submission logs its own error line (see reply-to-message.ts); muted
// here so a test that takes that path does not write it into the suite output.
const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const error = spyOn(logger, 'error').mockImplementation(() => undefined)
  try {
    const result = await replyToMessage(draftDeps(opts), store(), createSendGuard(), {
      args: replyToMessageInput.parse(args),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    return { result, text: result.content[0]?.text ?? '' }
  } finally {
    error.mockRestore()
  }
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
    expect(submissions[0]?.emailId).toBe('dNew1')
    expect(text).toContain('Reply sent.')
    expect(text).toContain('messageId: dNew1')
  })

  test('quotes the original below the reply unless quoteOriginal is false', async () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'Can you send the numbers?' } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const creates: DraftCreateParams[] = []
    await run({ messageId: 'e1', text: 'Here they are.' }, { creates, records: { e1: original } })
    await run({ messageId: 'e1', quoteOriginal: false, text: 'Here they are.' }, { creates, records: { e1: original } })
    expect(creates[0]?.draft.text).toBe(
      'Here they are.\n\n> Nadia Bram <nadia@example.org> wrote:\n>\n> Can you send the numbers?\n'
    )
    expect(creates[1]?.draft.text).toBe('Here they are.')
  })

  test('a failed send still says the quote was withheld', async () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'Can you send the numbers?' } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const { result, text } = await run(
      { messageId: 'e1', text: 'Looping you in.', to: ['outsider@example.net'] },
      { records: { e1: original }, submitError: new Error('socket hang up') }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('may already have gone out')
    expect(text).toContain('The original was not quoted: outsider@example.net')
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
    const guard = createSendGuard()
    const deps = draftDeps({ creates, records: { e1: receivedMessage() }, submissions })
    const ctx = {
      args: replyToMessageInput.parse({ idempotencyKey: 'k1', messageId: 'e1', text: 'hi' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }

    await replyToMessage(deps, replays, guard, ctx)
    const second = await replyToMessage(deps, replays, guard, ctx)

    expect(creates).toHaveLength(1)
    expect(submissions).toHaveLength(1)
    expect(second.content[0]?.text).toContain('no second reply was sent')
  })

  test('names the staged draft when the submission throws, so the reply is not lost', async () => {
    const creates: DraftCreateParams[] = []
    const deps = draftDeps({
      creates,
      records: { e1: receivedMessage() },
      submitError: new Error('socket hang up'),
    })
    // The failure is returned in-band, which tool-logging.ts records at `warn`.
    // This path is a real fault rather than a "the answer is no", so it has to
    // log its own `error` line or it would stop reaching error tracking.
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const result = await replyToMessage(deps, store(), createSendGuard(), {
        args: replyToMessageInput.parse({ messageId: 'e1', text: 'hi' }),
        principal: TEST_PRINCIPAL,
        token: 'tok',
      })
      expect(result.isError).toBe(true)
      const text = result.content[0]?.text ?? ''
      // The reply exists even though the send failed; naming it is the difference
      // between a recoverable message and a lost one.
      expect(text).toContain(`staged as draft ${creates[0] ? 'dNew1' : ''}`)
      // A lost answer may hide a delivery, so it must not claim nothing went out.
      expect(text).toContain('may already have gone out')
      expect(text).not.toContain('Nothing was sent')

      expect(error).toHaveBeenCalledTimes(1)
      const fields = error.mock.calls[0]?.[0] as Record<string, unknown>
      expect(fields.tool).toBe('reply_to_message')
      expect(fields.errorClass).toBe('Error')
      expect(fields.errorMessage).toBe('socket hang up')
    } finally {
      error.mockRestore()
    }
  })

  test('a blind retry after a lost response is refused rather than sending a second reply', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    const args = replyToMessageInput.parse({ messageId: 'e1', text: 'hi' })
    const ctx = { args, principal: TEST_PRINCIPAL, token: 'tok' }

    // First attempt: the answer is lost, so delivery is unknown.
    const lost = draftDeps({ records: { e1: receivedMessage() }, submitError: new Error('socket hang up') })
    await replyToMessage(lost, store(), guard, ctx)

    // The retry mints a *different* draft, so only a reservation keyed on the
    // message being answered can catch it.
    const retry = draftDeps({ records: { e1: receivedMessage() }, submissions })
    const second = await replyToMessage(retry, store(), guard, ctx)
    expect(second.isError).toBe(true)
    expect(second.content[0]?.text ?? '').toContain('could deliver a duplicate')
    expect(submissions).toEqual([])
  })

  test('a concurrent duplicate reply is refused before it stages anything', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    const deps = draftDeps({ creates, records: { e1: receivedMessage() }, submissions })
    const ctx = {
      args: replyToMessageInput.parse({ messageId: 'e1', text: 'hi' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    // Each call would stage its own draft with its own id, so a draft-keyed
    // reservation would guard nothing — this only holds because the reservation
    // is keyed on the message being answered.
    const results = await Promise.all([
      replyToMessage(deps, store(), guard, ctx),
      replyToMessage(deps, store(), guard, ctx),
    ])
    expect(submissions).toHaveLength(1)
    const blocked = results.find((r) => r.isError)
    expect(blocked?.content[0]?.text ?? '').toContain('already in progress')
    // e1 is the message being answered: reading it back says nothing about
    // whether the reply went out, so the refusal points at Sent instead.
    expect(blocked?.content[0]?.text ?? '').toContain('A reply to e1')
    expect(blocked?.content[0]?.text ?? '').toContain('Sent folder')
    // The reservation is taken before anything is staged, so the refused call
    // leaves no stray draft behind.
    expect(creates).toHaveLength(1)
  })

  test('a keyed retry that started before the first reply finished does not send a second one', async () => {
    // The counterexample spec/SendProtocol.tla found: the retry's replay lookup
    // runs while the first call is in flight and finds nothing, then the first
    // call records and releases before the retry reaches the reservation.
    // Reserving first puts the lookup inside the reservation.
    const submissions: EmailSubmissionCreateParams[] = []
    const firstSubmit = gate()
    const secondStage = gate()
    let stages = 0
    const base = draftDeps({ records: { e1: receivedMessage() }, submissions })
    const deps = {
      ...base,
      draftCreate: async (p: DraftCreateParams) => {
        stages += 1
        if (stages === 2) {
          await secondStage.passed
        }
        return base.draftCreate(p)
      },
      emailSubmissionCreate: async (p: EmailSubmissionCreateParams) => {
        await firstSubmit.passed
        return base.emailSubmissionCreate(p)
      },
    }
    const replays = store()
    const guard = createSendGuard()
    const ctx = {
      args: replyToMessageInput.parse({ idempotencyKey: 'k1', messageId: 'e1', text: 'hi' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }

    const first = replyToMessage(deps, replays, guard, ctx)
    await settle()
    const retry = replyToMessage(deps, replays, guard, ctx)
    await settle()
    firstSubmit.open()
    await first
    secondStage.open()
    await retry

    expect(submissions).toHaveLength(1)
  })

  test('the staged draft of a reply with an unknown outcome cannot be sent with send_draft', async () => {
    // Also found by the model: the reply's answer is lost while its submission is
    // still queued, and send_draft of the staged draft races it. The reply
    // covers its staged draft under send_draft's own reservation key.
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    const lost = draftDeps({ records: { e1: receivedMessage() }, submitError: new Error('socket hang up') })
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      await replyToMessage(lost, store(), guard, {
        args: replyToMessageInput.parse({ messageId: 'e1', text: 'hi' }),
        principal: TEST_PRINCIPAL,
        token: 'tok',
      })
    } finally {
      error.mockRestore()
    }

    const staged = draftDeps({ records: { dNew1: stagedDraft({ id: 'dNew1' }) }, submissions })
    const result = await sendDraft(staged, store(), guard, {
      args: sendDraftInput.parse({ draftId: 'dNew1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.content[0]?.text ?? '').toContain('could deliver a duplicate')
    expect(submissions).toEqual([])
  })

  test('a keyed retry after an unfiled reply is replayed, not refused as unknown', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const deps = draftDeps({
      records: { e1: receivedMessage() },
      submission: { filed: false, id: 's1' },
      submissions,
    })
    const replays = store()
    const guard = createSendGuard()
    const ctx = {
      args: replyToMessageInput.parse({ idempotencyKey: 'k1', messageId: 'e1', text: 'hi' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    await replyToMessage(deps, replays, guard, ctx)
    const retry = await replyToMessage(deps, replays, guard, ctx)
    expect(retry.content[0]?.text ?? '').toContain('no second reply was sent')
    expect(submissions).toHaveLength(1)
  })

  test('a failure before the submission is not reported as handed to the server', async () => {
    // The submission account is resolved before anything is staged or sent, so
    // a transport error there can only mean nothing was submitted.
    const submissions: EmailSubmissionCreateParams[] = []
    const deps = {
      ...draftDeps({ records: { e1: receivedMessage() }, submissions }),
      resolveSubmissionAccountId: () => Promise.reject(new Error('socket hang up')),
    }
    const guard = createSendGuard()
    const ctx = {
      args: replyToMessageInput.parse({ messageId: 'e1', text: 'hi' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    let text = ''
    try {
      const result = await replyToMessage(deps, store(), guard, ctx)
      text = result.content[0]?.text ?? ''
    } catch (thrown) {
      text = thrown instanceof Error ? thrown.message : ''
    } finally {
      error.mockRestore()
    }
    expect(text).not.toContain('handed to the server')
    expect(submissions).toEqual([])
    // Nothing went out, so a retry is not blocked as unknown.
    expect(guard.reserve(TEST_PRINCIPAL, { key: 'e1', tool: 'reply_to_message' })).toBeNull()
  })

  test('a reply the server refused says nothing went out and leaves its draft sendable', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    const refused = draftDeps({
      records: { e1: receivedMessage() },
      submitError: new JmapError(200, 'EmailSubmission/set did not send dNew1: forbiddenFrom', 'forbiddenFrom'),
    })
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    let text = ''
    try {
      const result = await replyToMessage(refused, store(), guard, {
        args: replyToMessageInput.parse({ messageId: 'e1', text: 'hi' }),
        principal: TEST_PRINCIPAL,
        token: 'tok',
      })
      text = result.content[0]?.text ?? ''
    } finally {
      error.mockRestore()
    }
    expect(text).toContain('Nothing was sent')
    expect(text).toContain('send it with send_draft')

    const staged = draftDeps({ records: { dNew1: stagedDraft({ id: 'dNew1' }) }, submissions })
    await sendDraft(staged, store(), guard, {
      args: sendDraftInput.parse({ draftId: 'dNew1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(submissions).toHaveLength(1)
  })

  test('falls back to the original thread when the new draft reports none', async () => {
    const { text } = await run(
      { messageId: 'e1', text: 'hi' },
      { created: { id: 'dNew', threadId: null }, records: { e1: receivedMessage() } }
    )
    expect(text).toContain('threadId: t1')
  })
})
