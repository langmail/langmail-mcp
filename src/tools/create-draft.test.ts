import { describe, expect, test } from 'bun:test'

import { type DraftCreateParams, type EmailSubmissionCreateParams } from '@langmail/jmap'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createDraft, createDraftInput } from './create-draft.ts'
import { type DraftDepsOptions, draftDeps, receivedMessage, TEST_PRINCIPAL } from './draft-test-fixtures.ts'

const store = () => createIdempotencyStore<string>()

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await createDraft(draftDeps(opts), store(), {
    args: createDraftInput.parse(args),
    principal: TEST_PRINCIPAL,
    token: 'tok',
  })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('createDraftInput schema', () => {
  test('accepts display-name recipients and rejects an over-long roster', () => {
    expect(createDraftInput.safeParse({ text: 'hi', to: ['Nadia Bram <nadia@example.org>'] }).success).toBe(true)
    expect(
      createDraftInput.safeParse({ text: 'hi', to: Array.from({ length: 51 }, (_, i) => `p${i}@example.org`) }).success
    ).toBe(false)
  })
})

describe('createDraft', () => {
  test('stages a draft, never sends, and reports what was staged', async () => {
    const creates: DraftCreateParams[] = []
    const submissions: EmailSubmissionCreateParams[] = []
    const { text } = await run(
      { subject: 'Quarterly numbers', text: 'Here they are.', to: ['Nadia Bram <nadia@example.org>'] },
      { creates, submissions }
    )

    // Nothing was submitted — this is the whole point of the staging half.
    expect(submissions).toEqual([])
    expect(creates).toHaveLength(1)
    expect(creates[0]?.mailboxId).toBe('mbDrafts')
    expect(creates[0]?.draft.to).toEqual([{ email: 'nadia@example.org', name: 'Nadia Bram' }])
    expect(creates[0]?.draft.from).toEqual([{ email: TEST_PRINCIPAL, name: 'Dana Okonjo' }])
    expect(creates[0]?.draft.text).toBe('Here they are.')

    expect(text).toContain('Nothing has been sent')
    expect(text).toContain('draftId: dNew')
    expect(text).toContain('to: Nadia Bram <nadia@example.org>')
    expect(text).toContain('body (text): Here they are.')
  })

  test('requires a body', async () => {
    const { result, text } = await run({ to: ['nadia@example.org'] })
    expect(result.isError).toBe(true)
    expect(text).toContain('Provide a body')
  })

  test('rejects a malformed recipient by name instead of dropping it', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run({ text: 'hi', to: ['nadia@example.org', 'Nadia Bram'] }, { creates })
    expect(result.isError).toBe(true)
    expect(text).toContain('Nadia Bram')
    expect(creates).toEqual([])
  })

  test('rejects a sending address the account has no identity for', async () => {
    const { result, text } = await run({ from: 'someone@example.org', text: 'hi', to: ['nadia@example.org'] })
    expect(result.isError).toBe(true)
    expect(text).toContain('cannot send as someone@example.org')
  })

  test('threads a reply from the message being answered', async () => {
    const creates: DraftCreateParams[] = []
    const { text } = await run({ inReplyTo: 'e1', text: 'Thanks!' }, { creates, records: { e1: receivedMessage() } })
    const draft = creates[0]?.draft
    expect(draft?.to).toEqual([{ email: 'nadia@example.org', name: 'Nadia Bram' }])
    expect(draft?.cc).toEqual([])
    expect(draft?.subject).toBe('Re: Quarterly numbers')
    expect(draft?.inReplyTo).toEqual(['orig@example.org'])
    expect(draft?.references).toEqual(['orig@example.org'])
    expect(text).toContain('threading: In-Reply-To/References set')
  })

  test('reply-all cc’s the rest of the original, minus the user', async () => {
    const creates: DraftCreateParams[] = []
    await run({ inReplyTo: 'e1', replyAll: true, text: 'Thanks!' }, { creates, records: { e1: receivedMessage() } })
    expect(creates[0]?.draft.cc).toEqual([{ email: 'tomas@example.com' }, { email: 'carl@example.org' }])
    // The user was on the original's To line; a reply-all must not mail them.
    const recipients = [...(creates[0]?.draft.to ?? []), ...(creates[0]?.draft.cc ?? [])]
    expect(recipients.map((a) => a.email)).not.toContain(TEST_PRINCIPAL)
  })

  test('explicit recipients override the derived reply recipients', async () => {
    const creates: DraftCreateParams[] = []
    await run(
      { inReplyTo: 'e1', text: 'Thanks!', to: ['tomas@example.com'] },
      { creates, records: { e1: receivedMessage() } }
    )
    expect(creates[0]?.draft.to).toEqual([{ email: 'tomas@example.com' }])
  })

  test('an explicit subject survives the reply defaulting', async () => {
    const creates: DraftCreateParams[] = []
    await run(
      { inReplyTo: 'e1', subject: 'New topic', text: 'Thanks!' },
      { creates, records: { e1: receivedMessage() } }
    )
    expect(creates[0]?.draft.subject).toBe('New topic')
  })

  test('refuses to stage a reply to a message that does not exist', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run({ inReplyTo: 'gone', text: 'hi' }, { creates })
    expect(result.isError).toBe(true)
    expect(text).toContain('message not found')
    expect(creates).toEqual([])
  })

  test('replays the first answer for a repeated idempotencyKey instead of staging twice', async () => {
    const creates: DraftCreateParams[] = []
    const replays = store()
    const deps = draftDeps({ creates })
    const args = createDraftInput.parse({ idempotencyKey: 'k1', text: 'hi', to: ['nadia@example.org'] })
    const ctx = { args, principal: TEST_PRINCIPAL, token: 'tok' }

    const first = await createDraft(deps, replays, ctx)
    const second = await createDraft(deps, replays, ctx)

    expect(creates).toHaveLength(1)
    expect(second.content[0]?.text).toContain('Replayed')
    expect(second.content[0]?.text).toContain('draftId: dNew')
    expect(first.content[0]?.text).not.toContain('Replayed')
  })

  test('scopes idempotency keys by principal', async () => {
    const creates: DraftCreateParams[] = []
    const replays = store()
    const deps = draftDeps({ creates })
    const args = createDraftInput.parse({ idempotencyKey: 'k1', text: 'hi', to: ['nadia@example.org'] })

    await createDraft(deps, replays, { args, principal: TEST_PRINCIPAL, token: 'tok' })
    await createDraft(deps, replays, { args, principal: 'other@langmail.me', token: 'tok2' })

    expect(creates).toHaveLength(2)
  })

  test('errors when the account has no Drafts folder', async () => {
    const result = await createDraft(draftDeps({ mailboxes: { drafts: null, sent: 'mbSent' } }), store(), {
      args: createDraftInput.parse({ text: 'hi', to: ['nadia@example.org'] }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no Drafts folder')
  })
})
