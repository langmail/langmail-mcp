import { describe, expect, spyOn, test } from 'bun:test'

import { type EmailSubmissionCreateParams, JmapError } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import { type DraftDepsOptions, draftDeps, gate, settle, stagedDraft, TEST_PRINCIPAL } from './draft-test-fixtures.ts'
import { sendDraft, sendDraftInput } from './send-draft.ts'

const store = () => createIdempotencyStore<string>()

// What send_draft reserves against: its own tool name plus the draft id.
const SUBJECT = { key: 'd1', tool: 'send_draft' }

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await sendDraft(draftDeps(opts), store(), createSendGuard(), {
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

  test('sends the current revision of an edited draft, by the id create_draft returned', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const edited = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:d1': true } })
    const { text } = await run({ draftId: 'd1' }, { records: { d2: edited }, submissions })
    // The submission names the message as it is now, not the id the caller holds.
    expect(submissions[0]?.emailId).toBe('d2')
    expect(text).toContain('messageId: d2')
  })

  test('names the sent message when the draft was already sent', async () => {
    const sent = stagedDraft({ id: 'd2', keywords: { $seen: true, '$draftid:tok1': true } })
    const { result, text } = await run({ draftId: 'tok1' }, { records: { d2: sent } })
    expect(result.isError).toBe(true)
    expect(text).toContain('already been sent')
    expect(text).toContain('passing id d2')
  })

  test('refuses a draft id that does not exist, and says nothing was sent', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const { result, text } = await run({ draftId: 'gone' }, { submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('Draft not found: gone')
    expect(text).toContain('Nothing was sent')
    expect(submissions).toEqual([])
  })

  test('refuses a draft nobody is addressed on, rather than letting the server reject it', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    // A draft the user started in Langmail and never addressed. create_draft
    // guards this at staging time, but this tool sends drafts it did not write.
    const unaddressed = stagedDraft({ bcc: [], cc: [], to: [] })
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: unaddressed }, submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('has no recipients')
    expect(text).toContain('Nothing was sent')
    expect(submissions).toEqual([])
  })

  test('points an unaddressed attached draft at update_draft, which can now edit it', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    // update_draft used to refuse an attached draft outright, so this case was
    // sent to Langmail instead. It carries attachments across now, which makes
    // "add the recipients with update_draft" the remedy on both paths.
    const attached = stagedDraft({ attachments: [{ partId: '2', type: 'application/pdf' }], to: [] })
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: attached }, submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('has no recipients')
    expect(text).toContain('then send it again')
    expect(submissions).toEqual([])
  })

  test('counts cc and bcc as recipients, so a to-less draft still sends', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const bccOnly = stagedDraft({ bcc: [{ email: 'nadia@example.org' }], to: [] })
    const { result } = await run({ draftId: 'd1' }, { records: { d1: bccOnly }, submissions })
    expect(result.isError).toBeUndefined()
    expect(submissions).toHaveLength(1)
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

  test('refuses a draft moved to Trash and sends nothing', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const trashed = stagedDraft({ mailboxIds: { mbTrash: true } })
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: trashed }, submissions })
    expect(result.isError).toBe(true)
    expect(text).toContain('Draft d1 is in Trash')
    expect(text).toContain('Nothing was sent')
    expect(submissions).toEqual([])
  })

  test('replays the first answer for a repeated idempotencyKey and does not resend', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const replays = store()
    const guard = createSendGuard()
    // The record stays a draft, so only the key can stop the second send.
    const deps = draftDeps({ records: { d1: stagedDraft() }, submissions })
    const ctx = {
      args: sendDraftInput.parse({ draftId: 'd1', idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }

    const first = await sendDraft(deps, replays, guard, ctx)
    const second = await sendDraft(deps, replays, guard, ctx)

    expect(submissions).toHaveLength(1)
    expect(first.content[0]?.text).toContain('messageId: d1')
    expect(second.content[0]?.text).toContain('NOT sent again')
    expect(second.content[0]?.text).toContain('messageId: d1')
  })

  test('says where the message went when the account has no Sent folder', async () => {
    const { text } = await run(
      { draftId: 'd1' },
      { mailboxes: { drafts: 'mbDrafts', sent: null, trash: 'mbTrash' }, records: { d1: stagedDraft() } }
    )
    expect(text).toContain('stayed in Drafts')
  })

  test('surfaces the release time when the server reports one', async () => {
    const { text } = await run(
      { draftId: 'd1' },
      { records: { d1: stagedDraft() }, submission: { filed: true, id: 's1', sendAt: '2026-07-30T09:00:00Z' } }
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

  test('warns loudly when the mail went out but the mailbox was not updated', async () => {
    const { result, text } = await run(
      { draftId: 'd1' },
      { records: { d1: stagedDraft() }, submission: { filed: false, id: 's1' } }
    )
    // The message is delivered but still flagged $draft, so the usual "still a
    // draft, so it can't have been sent" reasoning is wrong here.
    expect(result.isError).toBeUndefined()
    expect(text).toContain('WAS sent')
    expect(text).toContain('Do NOT send it again')
  })

  test('two concurrent sends of the same draft deliver once', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const replays = store()
    const guard = createSendGuard()
    const deps = draftDeps({ records: { d1: stagedDraft() }, submissions })
    const ctx = {
      args: sendDraftInput.parse({ draftId: 'd1', idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }

    // The retry-while-in-flight shape the idempotencyKey exists for: neither
    // call has recorded a replay yet, and the draft still reads as a draft
    // because the server has not applied the follow-up patch.
    const [a, b] = await Promise.all([sendDraft(deps, replays, guard, ctx), sendDraft(deps, replays, guard, ctx)])

    expect(submissions).toHaveLength(1)
    const outcomes = [a, b].map((r) => r.content[0]?.text ?? '')
    expect(outcomes.filter((t) => t.includes('Sent.'))).toHaveLength(1)
    expect(outcomes.filter((t) => t.includes('already in progress'))).toHaveLength(1)
  })

  test('a keyless concurrent retry is blocked too', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    const deps = draftDeps({ records: { d1: stagedDraft() }, submissions })
    const ctx = { args: sendDraftInput.parse({ draftId: 'd1' }), principal: TEST_PRINCIPAL, token: 'tok' }
    // The reservation is keyed on the draft, not the caller's key, so a client
    // retrying blind — the likelier shape — is covered as well.
    await Promise.all([sendDraft(deps, store(), guard, ctx), sendDraft(deps, store(), guard, ctx)])
    expect(submissions).toHaveLength(1)
  })

  test('a retry that read the draft before the first send landed does not send it again', async () => {
    // The counterexample spec/SendProtocol.tla found. The retry reads "still a
    // draft" while the first call is in flight, then the first call finishes and
    // releases, and only then does the retry reach the reservation. Reserving
    // after the read let it through; reserving first refuses it.
    const submissions: EmailSubmissionCreateParams[] = []
    const record = stagedDraft()
    const firstSubmit = gate()
    const secondMailboxes = gate()
    let mailboxReads = 0
    const base = draftDeps({ records: { d1: record }, submissions })
    const deps = {
      ...base,
      emailSubmissionCreate: async (p: EmailSubmissionCreateParams) => {
        await firstSubmit.passed
        // The server moves the message out of Drafts with the send.
        record.keywords = { $seen: true }
        record.mailboxIds = { mbSent: true }
        return base.emailSubmissionCreate(p)
      },
      resolveComposeMailboxes: async (authorization: string) => {
        mailboxReads += 1
        if (mailboxReads === 2) {
          await secondMailboxes.passed
        }
        return base.resolveComposeMailboxes(authorization)
      },
    }
    const guard = createSendGuard()
    const ctx = { args: sendDraftInput.parse({ draftId: 'd1' }), principal: TEST_PRINCIPAL, token: 'tok' }

    const first = sendDraft(deps, store(), guard, ctx)
    await settle()
    const retry = sendDraft(deps, store(), guard, ctx)
    await settle()
    firstSubmit.open()
    await first
    secondMailboxes.open()
    await retry

    expect(submissions).toHaveLength(1)
  })

  test('a keyed retry after an unfiled send is replayed, not refused as unknown', async () => {
    // Found by RetriesReplayed in spec/SendProtocol.tla: the unfiled path leaves
    // the reservation `unknown`, and a retry refused on it was told the send
    // "failed without saying whether the message went out" — although the
    // first call said it went out, and recorded that answer under the key.
    const submissions: EmailSubmissionCreateParams[] = []
    const deps = draftDeps({ records: { d1: stagedDraft() }, submission: { filed: false, id: 's1' }, submissions })
    const replays = store()
    const guard = createSendGuard()
    const ctx = {
      args: sendDraftInput.parse({ draftId: 'd1', idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    await sendDraft(deps, replays, guard, ctx)
    const retry = await sendDraft(deps, replays, guard, ctx)
    const text = retry.content[0]?.text ?? ''
    expect(text).toContain('WAS sent')
    expect(text).toContain('was NOT sent again')
    expect(submissions).toHaveLength(1)
  })

  test('a server refusal stays retryable; a transport failure does not', async () => {
    const jmapRefusal = new JmapError(200, 'EmailSubmission/set did not send d1: forbiddenFrom', 'forbiddenFrom')
    const refusingGuard = createSendGuard()
    const refusing = draftDeps({ records: { d1: stagedDraft() }, submitError: jmapRefusal })
    const ctx = { args: sendDraftInput.parse({ draftId: 'd1' }), principal: TEST_PRINCIPAL, token: 'tok' }
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const refused = await sendDraft(refusing, store(), refusingGuard, ctx)
      expect(refused.isError).toBe(true)
      expect(refused.content[0]?.text ?? '').toContain('forbiddenFrom')
      expect(refused.content[0]?.text ?? '').toContain('Nothing was sent')
      // The server answered "no", so nothing went out and the draft is free again.
      expect(refusingGuard.reserve(TEST_PRINCIPAL, SUBJECT)).toBeNull()

      const lostGuard = createSendGuard()
      const lost = draftDeps({ records: { d1: stagedDraft() }, submitError: new Error('socket hang up') })
      const unknown = await sendDraft(lost, store(), lostGuard, ctx)
      // The agent's first report is the one the user acts on: it must say the
      // message may have gone, not just relay the transport error.
      expect(unknown.isError).toBe(true)
      expect(unknown.content[0]?.text ?? '').toContain('may already have gone out')
      expect(unknown.content[0]?.text ?? '').not.toContain('Nothing was sent')
      // A lost answer might mean "delivered". Blocking is the safe direction.
      expect(lostGuard.reserve(TEST_PRINCIPAL, SUBJECT)).toEqual({ state: 'unknown' })
      // Both are real faults, so both still reach error tracking.
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  test('a send whose outcome is unknown is refused rather than retried', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    guard.reserve(TEST_PRINCIPAL, SUBJECT)
    guard.markUnknown(TEST_PRINCIPAL, SUBJECT)
    const result = await sendDraft(draftDeps({ records: { d1: stagedDraft() }, submissions }), store(), guard, {
      args: sendDraftInput.parse({ draftId: 'd1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text ?? '').toContain('could deliver a duplicate')
    expect(submissions).toEqual([])
  })

  test('a send whose outcome is unknown also blocks a retry through the draft’s other id', async () => {
    const submissions: EmailSubmissionCreateParams[] = []
    const guard = createSendGuard()
    // Sent by its draftId `tok1`, answer lost; the retry comes in with the
    // message id search_emails shows for the same draft.
    const tokenSubject = { key: 'tok1', tool: 'send_draft' }
    guard.reserve(TEST_PRINCIPAL, tokenSubject)
    guard.markUnknown(TEST_PRINCIPAL, tokenSubject)
    const edited = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:tok1': true } })
    const result = await sendDraft(draftDeps({ records: { d2: edited }, submissions }), store(), guard, {
      args: sendDraftInput.parse({ draftId: 'd2' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text ?? '').toContain('could deliver a duplicate')
    expect(submissions).toEqual([])
    // Refused before anything was sent, so its own reservation is released.
    expect(guard.reserve(TEST_PRINCIPAL, { key: 'd2', tool: 'send_draft' })).toBeNull()
  })

  test('releases the reservation once the message is marked no longer a draft', async () => {
    const guard = createSendGuard()
    await sendDraft(draftDeps({ records: { d1: stagedDraft() } }), store(), guard, {
      args: sendDraftInput.parse({ draftId: 'd1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    // The server-side $draft flag now does the blocking, so the reservation has
    // nothing left to protect.
    expect(guard.reserve(TEST_PRINCIPAL, SUBJECT)).toBeNull()
  })

  test('holds the reservation when the message was delivered but not marked sent', async () => {
    const guard = createSendGuard()
    await sendDraft(
      draftDeps({ records: { d1: stagedDraft() }, submission: { filed: false, id: 's1' } }),
      store(),
      guard,
      {
        args: sendDraftInput.parse({ draftId: 'd1' }),
        principal: TEST_PRINCIPAL,
        token: 'tok',
      }
    )
    // The structural guard is absent here — the message still reads as a draft —
    // so the reservation has to stay and refuse a retry.
    expect(guard.reserve(TEST_PRINCIPAL, SUBJECT)).toEqual({ state: 'unknown' })
  })

  test('does not record a replay when the submission itself fails', async () => {
    const replays = store()
    const guard = createSendGuard()
    const deps = draftDeps({ records: { d1: stagedDraft() }, submitError: new Error('smtp down') })
    const ctx = {
      args: sendDraftInput.parse({ draftId: 'd1', idempotencyKey: 'k1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    }
    const error = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const result = await sendDraft(deps, replays, guard, ctx)
      expect(result.isError).toBe(true)
    } finally {
      error.mockRestore()
    }
    // A failed send must stay retryable — the key can only shadow a success.
    expect(replays.lookup('send_draft', TEST_PRINCIPAL, 'k1')).toBeNull()
  })
})
