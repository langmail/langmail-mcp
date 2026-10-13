import { describe, expect, test } from 'bun:test'

import { type BlobUploadParams, type DraftCreateParams } from '@langmail/jmap'

import {
  type DraftDepsOptions,
  draftDeps,
  receivedMessage,
  stagedDraft,
  TEST_PRINCIPAL,
} from './draft-test-fixtures.ts'
import { attributionLine, withQuotedOriginal } from './reply-quote.ts'
import { updateDraft, updateDraftInput } from './update-draft.ts'

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await updateDraft(draftDeps(opts), {
    args: updateDraftInput.parse(args),
    principal: TEST_PRINCIPAL,
    token: 'tok',
  })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('updateDraft', () => {
  test('replaces the message but keeps the draftId', async () => {
    const creates: DraftCreateParams[] = []
    const { text } = await run(
      { draftId: 'd1', text: 'Corrected numbers.' },
      { created: { id: 'd2', replacedDestroyed: true, threadId: 't1' }, creates, records: { d1: stagedDraft() } }
    )
    expect(creates[0]?.replaces).toBe('d1')
    expect(creates[0]?.draft.text).toBe('Corrected numbers.')
    // The replacement carries the stable id, so `d1` keeps resolving to it.
    expect(creates[0]?.keywords).toContain('$draftid:d1')
    expect(text).toContain('draftId is unchanged')
    expect(text).toContain('still unsent')
    expect(text).toContain('draftId: d1')
    expect(text).not.toContain('d2')
  })

  test('a draft another client staged gets a draftId on its first edit, and the result says so', async () => {
    const creates: DraftCreateParams[] = []
    const foreign = stagedDraft({ keywords: { $draft: true, $seen: true } })
    const { text } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: foreign } })
    const token = creates[0]?.keywords?.[0]?.replace('$draftid:', '') ?? ''
    expect(token).not.toBe('')
    expect(token).not.toBe('d1')
    expect(text).toContain(`Its draftId is ${token}; use that from now on.`)
  })

  test('refuses to edit a draft moved to Trash, rather than re-staging it into Drafts', async () => {
    const creates: DraftCreateParams[] = []
    const trashed = stagedDraft({ mailboxIds: { mbTrash: true } })
    const { result, text } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: trashed } })
    expect(result.isError).toBe(true)
    expect(text).toContain('Draft d1 is in Trash')
    expect(text).toContain('left unchanged')
    expect(creates).toEqual([])
  })

  test('refuses quoteOriginal without new wording, changing nothing', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run(
      { draftId: 'd1', quoteOriginal: false },
      { creates, records: { d1: stagedDraft() } }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('only applies together with a new `text` or `html`')
    expect(creates).toEqual([])
  })

  test('a second edit by the same id reaches the current revision', async () => {
    const creates: DraftCreateParams[] = []
    const edited = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:d1': true } })
    const { text } = await run({ draftId: 'd1', subject: 'Again' }, { creates, records: { d2: edited } })
    expect(creates[0]?.replaces).toBe('d2')
    expect(creates[0]?.keywords).toEqual(['$draftid:d1'])
    expect(text).toContain('draftId: d1')
  })

  test('edits the current revision, not a superseded copy an earlier edit failed to remove', async () => {
    const creates: DraftCreateParams[] = []
    const stale = stagedDraft({ bodyValues: { '1': { value: 'Old.' } } })
    const current = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:d1': true } })
    await run({ draftId: 'd1', subject: 'Again' }, { creates, records: { d1: stale, d2: current } })
    expect(creates[0]?.replaces).toBe('d2')
    expect(creates[0]?.draft.text).toBe('Here they are.')
  })

  test('keeps every field the caller omitted', async () => {
    const creates: DraftCreateParams[] = []
    await run({ draftId: 'd1', subject: 'New subject' }, { creates, records: { d1: stagedDraft() } })
    const draft = creates[0]?.draft
    expect(draft?.subject).toBe('New subject')
    // Recipients, sender, and body all survive an edit that named none of them.
    expect(draft?.to).toEqual([{ email: 'nadia@example.org' }])
    expect(draft?.from).toEqual([{ email: 'user@langmail.me', name: 'Dana Okonjo' }])
    expect(draft?.text).toBe('Here they are.')
  })

  test('an empty recipient array clears that field', async () => {
    const creates: DraftCreateParams[] = []
    const staged = stagedDraft({ cc: [{ email: 'carl@example.org' }] })
    await run({ cc: [], draftId: 'd1' }, { creates, records: { d1: staged } })
    expect(creates[0]?.draft.cc).toEqual([])
    // `to` was not named, so it is kept — that's the difference an omitted
    // field has to make.
    expect(creates[0]?.draft.to).toEqual([{ email: 'nadia@example.org' }])
  })

  test('preserves the reply threading through an edit', async () => {
    const creates: DraftCreateParams[] = []
    const staged = stagedDraft({ inReplyTo: ['orig@example.org'], references: ['orig@example.org'] })
    await run({ draftId: 'd1', text: 'Rewritten.' }, { creates, records: { d1: staged } })
    expect(creates[0]?.draft.inReplyTo).toEqual(['orig@example.org'])
    expect(creates[0]?.draft.references).toEqual(['orig@example.org'])
  })

  test('refuses an unknown draft', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run({ draftId: 'gone', text: 'hi' }, { creates })
    expect(result.isError).toBe(true)
    expect(text).toContain('Draft not found')
    expect(creates).toEqual([])
  })

  test('refuses to edit a message that has already been sent', async () => {
    const creates: DraftCreateParams[] = []
    const sent = stagedDraft({ keywords: { $seen: true }, mailboxIds: { mbSent: true } })
    const { result, text } = await run({ draftId: 'd1', text: 'hi' }, { creates, records: { d1: sent } })
    expect(result.isError).toBe(true)
    expect(text).toContain('cannot be edited')
    expect(creates).toEqual([])
  })

  test('rejects a malformed replacement recipient', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run(
      { draftId: 'd1', to: ['Nadia Bram'] },
      { creates, records: { d1: stagedDraft() } }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('Nadia Bram')
    expect(creates).toEqual([])
  })

  test('refuses a partial body edit that would deliver the stale part', async () => {
    const creates: DraftCreateParams[] = []
    const both = stagedDraft({
      bodyValues: { '1': { value: 'OLD price is 5000' }, '2': { value: '<p>OLD price is 5000</p>' } },
      htmlBody: [{ partId: '2', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    // Mail clients render the html alternative, so replacing only `text` would
    // report the corrected body and deliver the old one.
    const { result, text } = await run({ draftId: 'd1', text: 'NEW price is 4000' }, { creates, records: { d1: both } })
    expect(result.isError).toBe(true)
    expect(text).toContain('only `text` was given')
    expect(text).toContain('Nothing was changed')
    expect(creates).toEqual([])
  })

  test('refuses a text edit that would leave an html-only draft rendering the old body', async () => {
    const creates: DraftCreateParams[] = []
    const htmlOnly = stagedDraft({
      bodyValues: { '2': { value: '<p>OLD price is 5000</p>' } },
      htmlBody: [{ partId: '2', type: 'text/html' }],
      textBody: [],
    })
    // The merged draft would carry both parts with only the text one refreshed —
    // and the html alternative is the one clients render.
    const { result, text } = await run(
      { draftId: 'd1', text: 'NEW price is 4000' },
      { creates, records: { d1: htmlOnly } }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('only `text` was given')
    expect(creates).toEqual([])
  })

  test('refuses an html edit that would leave a text-only draft carrying the old text', async () => {
    const creates: DraftCreateParams[] = []
    const textOnly = stagedDraft({
      bodyValues: { '1': { value: 'OLD price is 5000' } },
      htmlBody: [],
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    // The mirror of the html-only case: topping a single-part draft up with the
    // other part leaves the untouched one stale either way round.
    const { result, text } = await run(
      { draftId: 'd1', html: '<p>NEW price is 4000</p>' },
      { creates, records: { d1: textOnly } }
    )
    expect(result.isError).toBe(true)
    expect(text).toContain('only `html` was given')
    expect(creates).toEqual([])
  })

  test('allows a single-part draft to be edited in place with the same part', async () => {
    const creates: DraftCreateParams[] = []
    const textOnly = stagedDraft({
      bodyValues: { '1': { value: 'old' } },
      htmlBody: [],
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    // Nothing stale here — the draft stays single-part, so the guard must not
    // fire and block an ordinary edit.
    const { result } = await run({ draftId: 'd1', text: 'new' }, { creates, records: { d1: textOnly } })
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.draft.text).toBe('new')
    expect(creates[0]?.draft.html).toBeUndefined()
  })

  test('a truncated text attachment does not block an edit the way a truncated body does', async () => {
    const creates: DraftCreateParams[] = []
    // `fetchAllBodyValues` returns a bodyValue for every text/* part, so a large
    // .csv attachment comes back truncated too. Its bytes are re-referenced by
    // blobId, never re-staged from that text, so nothing is at risk — refusing
    // here would block a lossless edit and blame the body for it.
    const withBigCsv = stagedDraft({
      attachments: [{ blobId: 'Gexport', name: 'export.csv', size: 900_000, type: 'text/csv' }],
      bodyValues: { '1': { value: 'Here they are.' }, '9': { isTruncated: true, value: 'a,b,c…' } },
    })
    const { result } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: withBigCsv } })
    expect(result.isError).toBeUndefined()
    expect(creates).toHaveLength(1)
  })

  test('still refuses when the message body itself came back truncated', async () => {
    const creates: DraftCreateParams[] = []
    // The guard that matters: this text *is* re-staged by the rewrite, so
    // editing would silently amputate the user's message.
    const truncatedBody = stagedDraft({ bodyValues: { '1': { isTruncated: true, value: 'a very long body…' } } })
    const { result, text } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: truncatedBody } })
    expect(result.isError).toBe(true)
    expect(text).toContain('too large to edit')
    expect(creates).toEqual([])
  })

  test('carries the attached files across an edit that never mentions them', async () => {
    const creates: DraftCreateParams[] = []
    const blobUploads: BlobUploadParams[] = []
    const withFile = stagedDraft({
      attachments: [
        { blobId: 'Ginvoice', disposition: 'attachment', name: 'invoice.pdf', size: 1024, type: 'application/pdf' },
      ],
    })
    const { result, text } = await run(
      { draftId: 'd1', subject: 'New' },
      { blobUploads, creates, records: { d1: withFile } }
    )
    expect(result.isError).toBeUndefined()
    // The edit rewrites the message, and the original is destroyed on the way —
    // so a file dropped here would be unrecoverable.
    expect(creates[0]?.draft.attachments).toEqual([
      { blobId: 'Ginvoice', disposition: 'attachment', name: 'invoice.pdf', size: 1024, type: 'application/pdf' },
    ])
    // Re-referenced, not re-uploaded: the bytes never move for a subject edit.
    // (The stored disposition rides along too — see the jmap-level test.)
    expect(blobUploads).toEqual([])
    expect(text).toContain('invoice.pdf')
  })

  test('refuses an edit that would silently drop an attachment it cannot reference', async () => {
    const creates: DraftCreateParams[] = []
    // RFC 8621 allows a null blobId, and a part without one cannot be carried
    // onto the replacement. The rewrite would drop it and the destroy would make
    // that permanent — while reporting success.
    const unreferencable = stagedDraft({
      attachments: [{ name: 'scan.pdf', size: 4096, type: 'application/pdf' }],
    })
    const { result, text } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: unreferencable } })
    expect(result.isError).toBe(true)
    expect(text).toContain('scan.pdf')
    expect(text).toContain('left unchanged')
    expect(creates).toEqual([])
  })

  test('allows the edit when the caller replaces the attachment list outright', async () => {
    const creates: DraftCreateParams[] = []
    const unreferencable = stagedDraft({ attachments: [{ name: 'scan.pdf', type: 'application/pdf' }] })
    // Nothing is being lost silently here — the caller said what the edited
    // draft should carry, so the unreferencable part is not load-bearing.
    const { result } = await run(
      { attachments: [{ blobId: 'Gfresh', filename: 'fresh.pdf' }], draftId: 'd1' },
      { creates, records: { d1: unreferencable } }
    )
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.draft.attachments).toEqual([{ blobId: 'Gfresh', name: 'fresh.pdf', type: 'application/pdf' }])
  })

  test('an empty attachments array removes every file', async () => {
    const creates: DraftCreateParams[] = []
    const withFile = stagedDraft({
      attachments: [{ blobId: 'Ginvoice', name: 'invoice.pdf', size: 1024, type: 'application/pdf' }],
    })
    const { result } = await run({ attachments: [], draftId: 'd1' }, { creates, records: { d1: withFile } })
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.draft.attachments).toEqual([])
  })

  test('a supplied attachments list replaces the staged one wholesale', async () => {
    const creates: DraftCreateParams[] = []
    const blobUploads: BlobUploadParams[] = []
    const withFile = stagedDraft({
      attachments: [{ blobId: 'Gold', name: 'draft-invoice.pdf', size: 1024, type: 'application/pdf' }],
    })
    const { result } = await run(
      {
        attachments: [{ content: Buffer.from('%PDF-1.4 corrected').toString('base64'), filename: 'invoice.pdf' }],
        draftId: 'd1',
      },
      { blobUploads, creates, records: { d1: withFile } }
    )
    expect(result.isError).toBeUndefined()
    // The old file is gone, not appended to — and the new one's media type was
    // inferred from the .pdf the caller named.
    expect(creates[0]?.draft.attachments).toEqual([
      { blobId: 'blobUploaded1', name: 'invoice.pdf', type: 'application/pdf' },
    ])
    expect(blobUploads).toHaveLength(1)
  })

  test('attachments alone counts as an edit', async () => {
    const creates: DraftCreateParams[] = []
    const { result } = await run(
      { attachments: [{ blobId: 'Gcontract', filename: 'contract.pdf' }], draftId: 'd1' },
      { creates, records: { d1: stagedDraft() } }
    )
    expect(result.isError).toBeUndefined()
    expect(creates).toHaveLength(1)
  })

  test('refuses an edit that changes nothing, leaving the id valid', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run({ draftId: 'd1' }, { creates, records: { d1: stagedDraft() } })
    expect(result.isError).toBe(true)
    expect(text).toContain('left exactly as it is')
    // Replacing for nothing would invalidate every stored reference to the draft.
    expect(creates).toEqual([])
  })

  test('accepts a body edit that replaces both parts', async () => {
    const creates: DraftCreateParams[] = []
    const both = stagedDraft({
      bodyValues: { '1': { value: 'old' }, '2': { value: '<p>old</p>' } },
      htmlBody: [{ partId: '2', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const { result } = await run({ draftId: 'd1', html: '<p>new</p>', text: 'new' }, { creates, records: { d1: both } })
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.draft).toMatchObject({ html: '<p>new</p>', text: 'new' })
  })

  test('refuses to edit a draft whose body read back truncated', async () => {
    const creates: DraftCreateParams[] = []
    const truncated = stagedDraft({ bodyValues: { '1': { isTruncated: true, value: 'first 100k only' } } })
    // Re-staging a truncated read would amputate the message, and the original
    // is destroyed afterwards.
    const { result, text } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: truncated } })
    expect(result.isError).toBe(true)
    expect(text).toContain('too large to edit')
    expect(creates).toEqual([])
  })

  test('carries the user’s own labels onto the replacement', async () => {
    const creates: DraftCreateParams[] = []
    const tagged = stagedDraft({
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$label:Invoices': true },
    })
    await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: tagged } })
    // An edit rewrites the message, so without this the draft comes back untagged.
    expect(creates[0]?.keywords).toEqual(['$label:Invoices', '$draftid:d1'])
  })

  test('does not silently trim a body the caller did not touch', async () => {
    const creates: DraftCreateParams[] = []
    const padded = stagedDraft({ bodyValues: { '1': { value: '  leading and trailing  ' } } })
    await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: padded } })
    expect(creates[0]?.draft.text).toBe('  leading and trailing  ')
  })

  test('admits when the superseded draft could not be removed', async () => {
    const { text } = await run(
      { draftId: 'd1', text: 'hi' },
      { created: { id: 'd2', replacedDestroyed: false, threadId: null }, records: { d1: stagedDraft() } }
    )
    // The leftover holds the pre-edit content and the user sees it in their
    // client, so the note says which copy is stale.
    // …and names it, so the agent can tell the user which one to remove.
    expect(text).toContain('pre-edit copy (message d1) could not be removed')
    expect(text).toContain('trash_emails')
    expect(text).toContain('draftId: d1')
  })
})

describe('updateDraft on a reply', () => {
  const original = receivedMessage({
    bodyValues: { '1': { value: 'Can you send the Q2 figures?' } },
    sentAt: '2026-10-05T12:00:00Z',
    textBody: [{ partId: '1', type: 'text/plain' }],
  })
  const ATTRIBUTION = attributionLine(original)
  const replyDraft = (text: string) =>
    stagedDraft({
      bodyValues: { '1': { value: text } },
      inReplyTo: ['orig@example.org'],
      references: ['orig@example.org'],
    })
  const quotedReply = replyDraft(withQuotedOriginal({ text: 'Here they are, in full detail.' }, original).text ?? '')
  const occurrences = (text: string | undefined, needle: string) => (text ?? '').split(needle).length - 1

  test('re-attaches the quote below the new text', async () => {
    const creates: DraftCreateParams[] = []
    await run({ draftId: 'd1', text: 'Here they are.' }, { creates, records: { d1: quotedReply, e1: original } })
    const text = creates[0]?.draft.text ?? ''
    expect(text.startsWith('Here they are.\n')).toBe(true)
    expect(text).not.toContain('in full detail')
    expect(occurrences(text, ATTRIBUTION)).toBe(1)
    expect(text).toContain('> Can you send the Q2 figures?')
  })

  test('does not quote twice when the caller passes the whole body', async () => {
    const creates: DraftCreateParams[] = []
    const whole = withQuotedOriginal({ text: 'Here they are.' }, original).text ?? ''
    await run({ draftId: 'd1', text: whole }, { creates, records: { d1: quotedReply, e1: original } })
    expect(creates[0]?.draft.text).toBe(whole)
  })

  test('finds the original by the id create_draft recorded, even once the reply left its thread', async () => {
    const creates: DraftCreateParams[] = []
    // An edited subject makes the server file the reply in a thread of its own.
    const moved = {
      ...quotedReply,
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$draftreplyto:e1': true },
      threadId: 't2',
    }
    await run({ draftId: 'd1', text: 'Here they are.' }, { creates, records: { d1: moved, e1: original } })
    expect(occurrences(creates[0]?.draft.text, ATTRIBUTION)).toBe(1)
    // …and the next edit can find it the same way.
    expect(creates[0]?.keywords).toEqual(['$draftreplyto:e1', '$draftid:d1'])
  })

  test('says so when a quote another client wrote goes with the old wording', async () => {
    const creates: DraftCreateParams[] = []
    const foreign = replyDraft('Sure.\n\nOn 10/5/26 12:00, Nadia Bram wrote:\n> Can you send the Q2 figures?')
    const { text } = await run(
      { draftId: 'd1', text: 'Here they are.' },
      { creates, records: { d1: foreign, e1: original } }
    )
    expect(creates[0]?.draft.text).toBe('Here they are.')
    expect(text).toContain('format this tool did not write')
  })

  test('says the quote is gone for a CRLF body whose original cannot be found', async () => {
    const crlf = replyDraft('Sure.\r\n\r\nOn Mon, 5 Oct 2026, Nadia Bram wrote:\r\n> Q2?\r\n')
    const { text } = await run({ draftId: 'd1', text: 'Here they are.' }, { records: { d1: crlf } })
    expect(text).toContain('no quote was re-attached')
  })

  test('a bare reply whose original is gone is edited without a note', async () => {
    const { text } = await run({ draftId: 'd1', text: 'Here they are.' }, { records: { d1: replyDraft('Bare.') } })
    expect(text).not.toContain('no quote was re-attached')
  })

  test('does not quote a recorded id that now names a different message', async () => {
    const creates: DraftCreateParams[] = []
    // The recorded id was handed to another message after the original went.
    const recorded = {
      ...quotedReply,
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$draftreplyto:e9': true },
      threadId: 't2',
    }
    const stranger = receivedMessage({ id: 'e9', messageId: ['other@example.org'], threadId: 't9' })
    const { text } = await run(
      { draftId: 'd1', text: 'Here they are.' },
      { creates, records: { d1: recorded, e9: stranger } }
    )
    expect(creates[0]?.draft.text).toBe('Here they are.')
    expect(creates[0]?.keywords).not.toContain('$draftreplyto:e9')
    expect(text).toContain('no quote was re-attached')
  })

  test('leaves the quote off when the same edit adds someone the original was not addressed to', async () => {
    const creates: DraftCreateParams[] = []
    const { text } = await run(
      { cc: ['outsider@example.net'], draftId: 'd1', text: 'Looping you in.' },
      { creates, records: { d1: quotedReply, e1: original } }
    )
    expect(creates[0]?.draft.text).toBe('Looping you in.')
    expect(text).toContain('outsider@example.net was not on it')

    await run(
      { cc: ['outsider@example.net'], draftId: 'd1', quoteOriginal: true, text: 'Looping you in.' },
      { creates, records: { d1: quotedReply, e1: original } }
    )
    expect(occurrences(creates[1]?.draft.text, ATTRIBUTION)).toBe(1)
  })

  test('keeps the quote when the edit re-passes an outsider the staged quoted reply already named', async () => {
    const creates: DraftCreateParams[] = []
    // Staged with `quoteOriginal: true` despite the outsider: the user already decided.
    const consented = { ...quotedReply, cc: [{ email: 'outsider@example.net' }] }
    await run(
      { cc: ['outsider@example.net', 'carl@example.org'], draftId: 'd1', text: 'Reworded.' },
      { creates, records: { d1: consented, e1: original } }
    )
    expect(occurrences(creates[0]?.draft.text, ATTRIBUTION)).toBe(1)
  })

  test('a recipients-only edit that adds an outsider keeps the quote and says it now goes to them', async () => {
    const creates: DraftCreateParams[] = []
    const { text } = await run(
      { cc: ['outsider@example.net'], draftId: 'd1' },
      { creates, records: { d1: quotedReply, e1: original } }
    )
    expect(creates[0]?.draft.text).toBe(quotedReply.bodyValues?.['1']?.value)
    expect(text).toContain('now goes to them too')
    expect(text).toContain('quoteOriginal: false')
    expect(text).toContain('drop that recipient again')
  })

  test("a recipients-only edit that adds an outsider to another client's quoted reply says so too", async () => {
    const foreign = replyDraft('Sure.\n\nOn 10/5/26 12:00, Nadia Bram wrote:\n> Can you send the Q2 figures?')
    const { text } = await run(
      { cc: ['outsider@example.net'], draftId: 'd1' },
      { records: { d1: foreign, e1: original } }
    )
    expect(text).toContain('now goes to them too')
  })

  test('a disproved recorded original is not recorded again when the thread lookup fails', async () => {
    const creates: DraftCreateParams[] = []
    const recorded = {
      ...quotedReply,
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$draftreplyto:e9': true },
    }
    const stranger = receivedMessage({ id: 'e9', messageId: ['other@example.org'], threadId: 't9' })
    const deps = {
      ...draftDeps({ creates, records: { d1: recorded, e9: stranger } }),
      threadMessageFind: () => Promise.reject(new Error('socket hang up')),
    }
    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ cc: ['carl@example.org'], draftId: 'd1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.keywords).not.toContain('$draftreplyto:e9')
  })

  test('a whole body passed back with the quote and a new outsider says the quote goes to them', async () => {
    const creates: DraftCreateParams[] = []
    const whole = withQuotedOriginal({ text: 'Here they are.' }, original).text ?? ''
    const { text } = await run(
      { cc: ['outsider@example.net'], draftId: 'd1', text: whole },
      { creates, records: { d1: quotedReply, e1: original } }
    )
    expect(creates[0]?.draft.text).toBe(whole)
    expect(text).toContain('now goes to them too')
    // The remedy needs both halves: the quoted part left out, and the flag.
    expect(text).toContain('without the quoted part')
    expect(text).toContain('quoteOriginal: false')
  })

  test('passed-back quoted text on a bare reply is checked even when the edit names no recipients', async () => {
    const bare = { ...replyDraft('Noted.'), cc: [{ email: 'outsider@example.net' }] }
    const whole = withQuotedOriginal({ text: 'Here they are.' }, original).text ?? ''
    const { text } = await run({ draftId: 'd1', text: whole }, { records: { d1: bare, e1: original } })
    expect(text).toContain('outsider@example.net was not on it')
  })

  test('following the note takes the quote off for good', async () => {
    const creates: DraftCreateParams[] = []
    const whole = withQuotedOriginal({ text: 'Here they are.' }, original).text ?? ''
    // The revision the first call staged: the quote passed back, outsider on Cc.
    const restaged = { ...replyDraft(whole), cc: [{ email: 'outsider@example.net' }] }
    await run(
      { draftId: 'd1', quoteOriginal: false, text: 'Here they are.' },
      { creates, records: { d1: restaged, e1: original } }
    )
    expect(occurrences(creates[0]?.draft.text, ATTRIBUTION)).toBe(0)
  })

  test('passed-back quoted text is checked against every recipient when the staged reply was bare', async () => {
    const creates: DraftCreateParams[] = []
    // create_draft withheld the quote because of the outsider: nobody has seen it.
    const bare = { ...replyDraft('Noted.'), cc: [{ email: 'outsider@example.net' }] }
    const whole = withQuotedOriginal({ text: 'Here they are.' }, original).text ?? ''
    const { text } = await run(
      { cc: ['outsider@example.net', 'carl@example.org'], draftId: 'd1', text: whole },
      { creates, records: { d1: bare, e1: original } }
    )
    expect(text).toContain('outsider@example.net was not on it')
  })

  test("says the quote is gone for another client's attribution-less quote whose original cannot be found", async () => {
    const { text } = await run(
      { draftId: 'd1', text: 'Here they are.' },
      { records: { d1: replyDraft('Sure.\n\n> Can you send the Q2 figures?') } }
    )
    expect(text).toContain('no quote was re-attached')
  })

  test('a disproved recorded original is not recorded again when reading the thread hit fails', async () => {
    const creates: DraftCreateParams[] = []
    const recorded = {
      ...quotedReply,
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$draftreplyto:e9': true },
    }
    const stranger = receivedMessage({ id: 'e9', messageId: ['other@example.org'], threadId: 't9' })
    const base = draftDeps({ creates, records: { d1: recorded, e1: original, e9: stranger } })
    const deps = {
      ...base,
      emailComposeGet: (p: Parameters<typeof base.emailComposeGet>[0]) =>
        p.id === 'e1' ? Promise.reject(new Error('socket hang up')) : base.emailComposeGet(p),
    }
    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ cc: ['carl@example.org'], draftId: 'd1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.keywords).not.toContain('$draftreplyto:e9')
  })

  test('a recipients-only edit adding someone already on the original says nothing', async () => {
    const { text } = await run(
      { cc: ['carl@example.org'], draftId: 'd1' },
      { records: { d1: quotedReply, e1: original } }
    )
    expect(text).not.toContain('the quote now goes to them')
  })

  test('says the quote is gone for an HTML reply whose original cannot be found', async () => {
    const html = stagedDraft({
      bodyValues: { '1': { value: '<p>Sure.</p>\n<br>\n<div>On Mon, 5 Oct 2026, Nadia Bram wrote:</div>' } },
      htmlBody: [{ partId: '1', type: 'text/html' }],
      inReplyTo: ['orig@example.org'],
      textBody: [],
    })
    const { text } = await run({ draftId: 'd1', html: '<p>Here they are.</p>' }, { records: { d1: html } })
    expect(text).toContain('no quote was re-attached')
  })

  test('counts the signed-in address as the user, even when it is not a sending identity', async () => {
    const creates: DraftCreateParams[] = []
    // An aliased login: the principal is not among the account's identities.
    const result = await updateDraft(draftDeps({ creates, records: { d1: quotedReply, e1: original } }), {
      args: updateDraftInput.parse({ cc: ['login@langmail.me'], draftId: 'd1', text: 'Here they are.' }),
      principal: 'login@langmail.me',
      token: 'tok',
    })
    expect(result.content[0]?.text).not.toContain('was not on it')
    expect(occurrences(creates[0]?.draft.text, ATTRIBUTION)).toBe(1)
  })

  test('a tolerated read failure keeps the original id already recorded', async () => {
    const creates: DraftCreateParams[] = []
    const recorded = {
      ...quotedReply,
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$draftreplyto:e1': true },
    }
    const base = draftDeps({ creates, records: { d1: recorded, e1: original } })
    const deps = {
      ...base,
      emailComposeGet: (p: Parameters<typeof base.emailComposeGet>[0]) =>
        p.id === 'e1' ? Promise.reject(new Error('socket hang up')) : base.emailComposeGet(p),
    }
    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ cc: ['carl@example.org'], draftId: 'd1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(creates[0]?.keywords).toContain('$draftreplyto:e1')
  })

  test('a recipients-only edit goes ahead when the thread lookup fails', async () => {
    const creates: DraftCreateParams[] = []
    const deps = {
      ...draftDeps({ creates, records: { d1: quotedReply, e1: original } }),
      threadMessageFind: () => Promise.reject(new Error('socket hang up')),
    }
    const result = await updateDraft(deps, {
      args: updateDraftInput.parse({ cc: ['carl@example.org'], draftId: 'd1' }),
      principal: TEST_PRINCIPAL,
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(creates).toHaveLength(1)
  })

  test('quoteOriginal: false drops the quote', async () => {
    const creates: DraftCreateParams[] = []
    await run(
      { draftId: 'd1', quoteOriginal: false, text: 'Here they are.' },
      { creates, records: { d1: quotedReply, e1: original } }
    )
    expect(creates[0]?.draft.text).toBe('Here they are.')
  })

  test('a bare reply stays bare, unless quoteOriginal: true asks for the quote', async () => {
    const bare = replyDraft('Here they are, in full detail.')
    const creates: DraftCreateParams[] = []
    await run({ draftId: 'd1', text: 'Here they are.' }, { creates, records: { d1: bare, e1: original } })
    expect(creates[0]?.draft.text).toBe('Here they are.')

    await run(
      { draftId: 'd1', quoteOriginal: true, text: 'Here they are.' },
      { creates, records: { d1: bare, e1: original } }
    )
    expect(occurrences(creates[1]?.draft.text, ATTRIBUTION)).toBe(1)
  })

  test('says so when the original is gone and the quote cannot be re-attached', async () => {
    const creates: DraftCreateParams[] = []
    const { text } = await run({ draftId: 'd1', text: 'Here they are.' }, { creates, records: { d1: quotedReply } })
    expect(creates[0]?.draft.text).toBe('Here they are.')
    expect(text).toContain('no quote was re-attached')
  })

  test('an edit that leaves the body alone keeps the quote as staged', async () => {
    const creates: DraftCreateParams[] = []
    await run({ draftId: 'd1', subject: 'Re: Q2' }, { creates, records: { d1: quotedReply, e1: original } })
    expect(creates[0]?.draft.text).toBe(quotedReply.bodyValues?.['1']?.value)
    // A reply another client staged has no recorded original; the thread finds
    // it now, before the new subject moves the reply out of that thread.
    expect(creates[0]?.keywords).toContain('$draftreplyto:e1')
  })
})
