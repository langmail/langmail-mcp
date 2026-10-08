import { describe, expect, test } from 'bun:test'

import { type BlobUploadParams, type DraftCreateParams, type EmailSubmissionCreateParams } from '@langmail/jmap'

import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createDraft, createDraftInput } from './create-draft.ts'
import { type DraftDepsOptions, draftDeps, receivedMessage, TEST_PRINCIPAL } from './draft-test-fixtures.ts'

const store = () => createIdempotencyStore<string>()

const DRAFT_ID_RE = /draftId: (\S+)/u

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
    // The draftId is a token the draft carries as a keyword, not its JMAP id.
    const draftId = DRAFT_ID_RE.exec(text)?.[1] ?? ''
    expect(draftId).not.toBe('dNew1')
    expect(creates[0]?.keywords).toEqual([`$draftid:${draftId}`])
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

  test('quotes the original below a reply by default, and not when quoteOriginal is false', async () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'Can you send the numbers?' } },
      receivedAt: '2026-10-05T12:00:00Z',
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const creates: DraftCreateParams[] = []
    await run({ inReplyTo: 'e1', text: 'Here they are.' }, { creates, records: { e1: original } })
    await run({ inReplyTo: 'e1', quoteOriginal: false, text: 'Here they are.' }, { creates, records: { e1: original } })
    expect(creates[0]?.draft.text).toBe(
      'Here they are.\n\n> On Mon, 5 Oct 2026 at 12:00 UTC, Nadia Bram <nadia@example.org> wrote:\n>\n' +
        '> Can you send the numbers?\n'
    )
    expect(creates[1]?.draft.text).toBe('Here they are.')
  })

  test('records the message a reply answers, so update_draft can quote it again', async () => {
    const creates: DraftCreateParams[] = []
    await run({ inReplyTo: 'e1', text: 'Here they are.' }, { creates, records: { e1: receivedMessage() } })
    await run({ text: 'Hello.', to: ['nadia@example.org'] }, { creates })
    expect(creates[0]?.keywords?.[0]).toBe('$draftreplyto:e1')
    expect(creates[1]?.keywords?.some((keyword) => keyword.startsWith('$draftreplyto:'))).toBe(false)
  })

  test('does not quote the original to a recipient it was never addressed to, unless asked', async () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'Can you send the numbers?' } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const creates: DraftCreateParams[] = []
    const args = { inReplyTo: 'e1', text: 'Looping you in.', to: ['outsider@example.net'] }
    await run(args, { creates, records: { e1: original } })
    await run({ ...args, quoteOriginal: true }, { creates, records: { e1: original } })
    expect(creates[0]?.draft.text).toBe('Looping you in.')
    expect(creates[1]?.draft.text).toContain('> Can you send the numbers?')
  })

  test('says when the quote was withheld, and still quotes for a self-bcc', async () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'Can you send the numbers?' } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const creates: DraftCreateParams[] = []
    const withheld = await run(
      { inReplyTo: 'e1', text: 'Looping you in.', to: ['outsider@example.net'] },
      { creates, records: { e1: original } }
    )
    expect(withheld.text).toContain('The original was not quoted: outsider@example.net')
    const selfCopy = await run(
      { bcc: [TEST_PRINCIPAL], inReplyTo: 'e1', text: 'Here they are.' },
      { creates, records: { e1: original } }
    )
    expect(selfCopy.text).not.toContain('not quoted')
    expect(creates[1]?.draft.text).toContain('> Can you send the numbers?')
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

  test('rejects replyAll combined with explicit recipients, as reply_to_message does', async () => {
    const creates: DraftCreateParams[] = []
    // Per-field precedence here silently dropped the person being replied to:
    // the derived Cc excludes the derived To, so with an explicit `to` the
    // original sender landed in neither list.
    const { result, text } = await run(
      { inReplyTo: 'e1', replyAll: true, text: 'hi', to: ['tomas@example.com'] },
      { creates, records: { e1: receivedMessage() } }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('replyAll cannot be combined')
    expect(creates).toEqual([])
  })

  test('refuses a reply that would have no recipient', async () => {
    const creates: DraftCreateParams[] = []
    // Replying to the user's own message: every address on it is theirs, so
    // every candidate recipient is excluded. That's a follow-up, not a reply.
    const own = receivedMessage({ cc: [], from: [{ email: TEST_PRINCIPAL }], to: [{ email: 'nadia@example.org' }] })
    const { result, text } = await run({ inReplyTo: 'e1', text: 'following up' }, { creates, records: { e1: own } })
    expect(result.isError).toBe(true)
    expect(text).toContain('leaves no recipient')
    expect(creates).toEqual([])
  })

  test('requires recipients or a message to derive them from', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run({ text: 'hi' }, { creates })
    expect(result.isError).toBe(true)
    expect(text).toContain('Provide recipients')
    // A draft with no recipients cannot be sent, so failing now beats failing
    // at send_draft.
    expect(creates).toEqual([])
  })

  test('treats an empty recipient array as no recipients, not as recipients given', async () => {
    const creates: DraftCreateParams[] = []
    const { result } = await run({ text: 'hi', to: [] }, { creates })
    expect(result.isError).toBe(true)
    expect(creates).toEqual([])
  })

  test('accepts a draft addressed only via cc', async () => {
    const creates: DraftCreateParams[] = []
    const { result } = await run({ cc: ['nadia@example.org'], text: 'hi' }, { creates })
    expect(result.isError).toBeUndefined()
    expect(creates).toHaveLength(1)
  })

  test('excludes every address that is the user, not just the sending one', async () => {
    const creates: DraftCreateParams[] = []
    // The original was addressed to one of the user's aliases; a reply-all must
    // not deliver the user their own reply.
    const toAlias = receivedMessage({ cc: [{ email: 'carl@example.org' }], to: [{ email: 'sales@langmail.me' }] })
    await run(
      { inReplyTo: 'e1', replyAll: true, text: 'hi' },
      {
        creates,
        identities: [
          { email: TEST_PRINCIPAL, id: 'i1', name: 'Dana Okonjo' },
          { email: 'sales@langmail.me', id: 'i2' },
        ],
        records: { e1: toAlias },
      }
    )
    const recipients = [...(creates[0]?.draft.to ?? []), ...(creates[0]?.draft.cc ?? [])]
    expect(recipients.map((a) => a.email)).toEqual(['nadia@example.org', 'carl@example.org'])
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

  test('stages a generated file as an attachment in the same call', async () => {
    // The motivating case: the agent has the bytes and the draft, and connects
    // the two without the user opening the mailbox.
    const creates: DraftCreateParams[] = []
    const blobUploads: BlobUploadParams[] = []
    const { result, text } = await run(
      {
        attachments: [{ content: Buffer.from('%PDF-1.4 invoice').toString('base64'), filename: 'RE-2026-006.pdf' }],
        text: 'Corrected invoice attached.',
        to: ['nadia@example.org'],
      },
      { blobUploads, creates }
    )
    expect(result.isError).toBeUndefined()
    expect(blobUploads[0]?.type).toBe('application/pdf')
    expect(creates[0]?.draft.attachments).toEqual([
      { blobId: 'blobUploaded1', name: 'RE-2026-006.pdf', type: 'application/pdf' },
    ])
    // Reported back, so the agent can tell the user what it staged.
    expect(text).toContain('attachments (1):')
    expect(text).toContain('RE-2026-006.pdf')
  })

  test('forwards a mailbox attachment by blobId without moving any bytes', async () => {
    const creates: DraftCreateParams[] = []
    const blobUploads: BlobUploadParams[] = []
    await run(
      {
        attachments: [{ blobId: 'Gcontract', filename: 'contract.pdf' }],
        text: 'Forwarding the contract.',
        to: ['lawyer@example.org'],
      },
      { blobUploads, creates }
    )
    expect(creates[0]?.draft.attachments).toEqual([
      { blobId: 'Gcontract', name: 'contract.pdf', type: 'application/pdf' },
    ])
    expect(blobUploads).toEqual([])
  })

  test('stages nothing when an attachment cannot be resolved', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run(
      { attachments: [{ content: 'not base64!!', filename: 'x.pdf' }], text: 'hi', to: ['nadia@example.org'] },
      { creates }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('not valid base64')
    // The draft is not staged half-attached.
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
    expect(DRAFT_ID_RE.exec(second.content[0]?.text ?? '')?.[1]).toBe(
      DRAFT_ID_RE.exec(first.content[0]?.text ?? '')?.[1]
    )
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
