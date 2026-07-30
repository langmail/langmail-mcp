import { describe, expect, test } from 'bun:test'

import { type EmailSubmissionCreateParams } from '@langmail/jmap'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { type DraftDepsOptions, draftDeps, stagedDraft, TEST_PRINCIPAL } from './draft-test-fixtures.ts'
import { sendDraft, sendDraftInput } from './send-draft.ts'

const store = () => createIdempotencyStore<string>()

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await sendDraft(draftDeps(opts), store(), {
    args: sendDraftInput.parse(args),
    principal: TEST_PRINCIPAL,
    token: 'tok',
  })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('sendDraft', () => {
  test('submits the draft under its own sending identity and returns the sent message id', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { text } = await run({ draftId: 'd1' }, { records: { d1: stagedDraft() }, submissions })

    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.emailId).toBe('d1')
    expect(submissions[0]?.identityId).toBe('i1')
    // The move out of Drafts rides in the same submission, so a send can't
    // half-commit into "delivered but still a draft".
    expect(submissions[0]?.draftsMailboxId).toBe('mbDrafts')
    expect(submissions[0]?.sentMailboxId).toBe('mbSent')

    expect(text).toContain('Sent.')
    // The Email id survives the mailbox move, so the draft id is the sent id.
    expect(text).toContain('messageId: d1')
    expect(text).toContain('threadId: t1')
    expect(text).toContain('get_email')
  })

  test('refuses a draft id that does not exist, and says nothing was sent', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { result, text } = await run({ draftId: 'gone' }, { submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('Draft not found: gone')
    expect(text).toContain('Nothing was sent')
    // Points at the update_draft id churn, which is the likely cause.
    expect(text).toContain('update_draft returned')
    expect(submissions).toEqual([])
  })

  test('refuses a message that is no longer a draft rather than sending it twice', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    // What the mailbox looks like after a successful send: out of Drafts, no
    // $draft keyword. This is the structural duplicate-send guard, and it works
    // whether or not the client passed an idempotencyKey.
    const sent = stagedDraft({ keywords: { $seen: true }, mailboxIds: { mbSent: true } })
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: sent }, submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('already been sent')
    expect(submissions).toEqual([])
  })

  test('replays the first answer for a repeated idempotencyKey and does not resend', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const replays = store()
    // The record stays a draft, so only the key can stop the second send.
    const deps = draftDeps({ records: { d1: stagedDraft() }, submissions })
    const ctx = {
      args: sendDraftInput.parse({ draftId: 'd1', idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }

    const first = await sendDraft(deps, replays, ctx)
    const second = await sendDraft(deps, replays, ctx)

    expect(submissions).toHaveLength(1)
    expect(first.content[0]?.text).toContain('messageId: d1')
    expect(second.content[0]?.text).toContain('NOT sent again')
    expect(second.content[0]?.text).toContain('messageId: d1')
  })

  test('says where the message went when the account has no Sent folder', async () => {
    const { text } = await run(
      { draftId: 'd1' },
      { mailboxes: { drafts: 'mbDrafts', sent: null }, records: { d1: stagedDraft() } }
    )
    expect(text).toContain('stayed in Drafts')
  })

  test('surfaces the release time when the server reports one', async () => {
    const { text } = await run(
      { draftId: 'd1' },
      { records: { d1: stagedDraft() }, submission: { id: 's1', sendAt: '2026-07-30T09:00:00Z' } }
    )
    expect(text).toContain('sendAt: 2026-07-30T09:00:00Z')
  })

  test('refuses a draft with no sender address', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: stagedDraft({ from: [] }) }, submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('no sender address')
    expect(submissions).toEqual([])
  })

  test('refuses when the draft is from an address the account can no longer send as', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { result, text } = await run(
      { draftId: 'd1' },
      { records: { d1: stagedDraft({ from: [{ email: 'retired-alias@langmail.me' }] }) }, submissions }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('cannot send as retired-alias@langmail.me')
    expect(submissions).toEqual([])
  })

  test('does not record a replay when the submission itself fails', async () => {
    const replays = store()
    const deps = draftDeps({ records: { d1: stagedDraft() }, submitError: new Error('smtp down') })
    const ctx = {
      args: sendDraftInput.parse({ draftId: 'd1', idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    await expect(sendDraft(deps, replays, ctx)).rejects.toThrow('smtp down')
    // A failed send must stay retryable — the key can only shadow a success.
    expect(replays.lookup(TEST_PRINCIPAL, 'k1')).toBeNull()
  })
})
