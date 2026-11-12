import { describe, expect, spyOn, test } from 'bun:test'

import {
  type DraftCreateParams,
  type EmailComposeRecord,
  type EmailSetParams,
  type EmailSubmissionCreateParams,
  JmapError,
} from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import { type DraftDepsOptions, draftDeps, receivedMessage, TEST_PRINCIPAL } from './draft-test-fixtures.ts'
import { forwardMessage, forwardMessageInput } from './forward-message.ts'

const store = () => createIdempotencyStore<string>()

const invoice = (overrides: Partial<EmailComposeRecord> = {}): EmailComposeRecord =>
  receivedMessage({
    attachments: [{ blobId: 'bPdf', disposition: 'attachment', name: 'invoice.pdf', type: 'application/pdf' }],
    blobId: 'bRaw',
    bodyValues: { h: { value: '<p>Rent for <b>March</b></p>' }, t: { value: 'Rent for March' } },
    from: [{ email: 'landlord@example.org', name: 'Ola Landlord' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
    sentAt: '2026-03-01T09:30:00Z',
    subject: 'Invoice March',
    textBody: [{ partId: 't', type: 'text/plain' }],
    ...overrides,
  })

// A failed submission logs its own error line; muted so the suite output stays clean.
const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const error = spyOn(logger, 'error').mockImplementation(() => undefined)
  try {
    const result = await forwardMessage(draftDeps(opts), store(), createSendGuard(), {
      args: forwardMessageInput.parse(args),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    return { result, text: result.content[0]?.text ?? '' }
  } finally {
    error.mockRestore()
  }
}

const ARGS = { messageId: 'e1', text: 'for the tax return', to: ['accountant@example.com'] }

describe('forwardMessage', () => {
  test('stages and sends the forward in one call, then marks the original $forwarded', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const keywordSets: EmailSetParams[] = []
    const { result, text } = await run(ARGS, { creates, keywordSets, records: { e1: invoice() }, submissions })

    expect(result.isError).toBeUndefined()
    const draft = creates[0]?.draft
    expect(draft?.to).toEqual([{ email: 'accountant@example.com' }])
    expect(draft?.cc).toBeUndefined()
    expect(draft?.subject).toBe('Fwd: Invoice March')
    expect(draft?.references).toEqual(['orig@example.org'])
    expect(draft?.inReplyTo).toBeUndefined()
    expect(draft?.text).toContain('for the tax return')
    expect(draft?.text).toContain('From: Ola Landlord <landlord@example.org>')
    expect(draft?.html).toContain('<b>March</b>')
    expect(draft?.attachments?.map((file) => file.blobId)).toEqual(['bPdf'])
    expect(creates[0]?.keywords).toEqual(['$draftforwardof:e1'])

    expect(submissions).toHaveLength(1)
    expect(text).toContain('Forward sent.')
    expect(text).toContain('invoice.pdf')
    expect(keywordSets).toEqual([
      expect.objectContaining({ changes: { keywords: { $forwarded: true } }, id: 'e1' }) as EmailSetParams,
    ])
  })

  test('requires a recipient, and never takes one from the original', () => {
    expect(forwardMessageInput.safeParse({ messageId: 'e1' }).success).toBe(false)
    expect(forwardMessageInput.safeParse({ messageId: 'e1', to: [] }).success).toBe(false)
  })

  test('refuses a malformed address before anything is staged', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run(
      { messageId: 'e1', to: ['not-an-address'] },
      { creates, records: { e1: invoice() } }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('Nothing was sent')
    expect(creates).toHaveLength(0)
  })

  test('refuses a missing message', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { text } = await run(ARGS, { submissions })
    expect(text).toContain('message not found: e1')
    expect(submissions).toHaveLength(0)
  })

  test('refuses an original whose file cannot be carried, and sends nothing', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const original = invoice({ attachments: [{ name: 'odd.bin', type: 'application/octet-stream' }] })
    const { text } = await run(ARGS, { records: { e1: original }, submissions })
    expect(text).toContain('odd.bin')
    expect(text).toContain('Nothing was sent')
    expect(text).toContain('forwardOf')
    expect(submissions).toHaveLength(0)
  })

  test('says when the original went along as a .eml file', async () => {
    const long = 'x'.repeat(120_000)
    const creates: DraftCreateParams[] = []
    const { text } = await run(ARGS, {
      creates,
      records: { e1: invoice({ bodyValues: { h: { value: long }, t: { value: long } } }) },
    })
    expect(creates[0]?.draft.attachments?.at(-1)?.type).toBe('message/rfc822')
    expect(text).toContain('attached as an .eml file')
  })

  test('a refused submission sends nothing and does not mark the original', async () => {
    const keywordSets: EmailSetParams[] = []
    const { text } = await run(ARGS, {
      keywordSets,
      records: { e1: invoice() },
      submitError: new JmapError(200, 'refused', 'forbiddenFrom'),
    })
    expect(text).toContain('Nothing was sent')
    expect(text).toContain('send_draft')
    expect(keywordSets).toHaveLength(0)
  })

  test('a lost answer says it may have gone out', async () => {
    const { text } = await run(ARGS, { records: { e1: invoice() }, submitError: new Error('socket hang up') })
    expect(text).toContain('may already have gone out')
  })

  test('a failed $forwarded mark is a note, not a failed send', async () => {
    const { result, text } = await run(ARGS, { keywordSetError: new Error('boom'), records: { e1: invoice() } })
    expect(result.isError).toBeUndefined()
    expect(text).toContain('Forward sent.')
    expect(text).toContain('could not be marked as forwarded')
  })

  test('replays a repeated idempotencyKey instead of sending a second forward', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const replays = store()
    const guard = createSendGuard()
    const deps = draftDeps({ records: { e1: invoice() }, submissions })
    const ctx = {
      args: forwardMessageInput.parse({ ...ARGS, idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    await forwardMessage(deps, replays, guard, ctx)
    const second = await forwardMessage(deps, replays, guard, ctx)
    expect(submissions).toHaveLength(1)
    expect(second.content[0]?.text).toContain('no second forward was sent')
  })

  test('a concurrent duplicate forward is refused before it stages anything', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    const deps = draftDeps({ creates, records: { e1: invoice() }, submissions })
    const ctx = { args: forwardMessageInput.parse(ARGS), principal: TEST_PRINCIPAL, token: 'tok' }
    const results = await Promise.all([
      forwardMessage(deps, store(), guard, ctx),
      forwardMessage(deps, store(), guard, ctx),
    ])
    expect(submissions).toHaveLength(1)
    expect(creates).toHaveLength(1)
    expect(results.find((r) => r.isError)?.content[0]?.text).toContain('A forward of e1 is already in progress')
  })
})
