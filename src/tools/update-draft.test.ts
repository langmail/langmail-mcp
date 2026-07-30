import { describe, expect, test } from 'bun:test'

import { type DraftCreateParams } from '@langmail/jmap'

import { type DraftDepsOptions, draftDeps, stagedDraft } from './draft-test-fixtures.ts'
import { updateDraft, updateDraftInput } from './update-draft.ts'

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await updateDraft(draftDeps(opts), { args: updateDraftInput.parse(args), token: 'tok' })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('updateDraft', () => {
  test('replaces the draft and returns the new id', async () => {
    const creates: DraftCreateParams[] = []
    const { text } = await run(
      { draftId: 'd1', text: 'Corrected numbers.' },
      { created: { id: 'd2', replacedDestroyed: true, threadId: 't1' }, creates, records: { d1: stagedDraft() } }
    )
    expect(creates[0]?.replaces).toBe('d1')
    expect(creates[0]?.draft.text).toBe('Corrected numbers.')
    expect(text).toContain('its id is now d2')
    expect(text).toContain('still unsent')
    expect(text).toContain('draftId: d2')
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

  test('refuses to edit a draft with attachments rather than dropping them', async () => {
    const creates: DraftCreateParams[] = []
    const withFile = stagedDraft({
      attachments: [{ blobId: 'Ginvoice', name: 'invoice.pdf', size: 1024, type: 'application/pdf' }],
    })
    // The edit rewrites the message and cannot carry attachment parts across, and
    // the original is destroyed on the way — so losing the file is unrecoverable.
    const { result, text } = await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: withFile } })
    expect(result.isError).toBe(true)
    expect(text).toContain('has attachments')
    expect(creates).toEqual([])
  })

  test('refuses an edit that changes nothing, leaving the id valid', async () => {
    const creates: DraftCreateParams[] = []
    const { result, text } = await run({ draftId: 'd1' }, { creates, records: { d1: stagedDraft() } })
    expect(result.isError).toBe(true)
    expect(text).toContain('its id still works')
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
    const tagged = stagedDraft({ keywords: { $draft: true, $seen: true, '$label:Invoices': true } })
    await run({ draftId: 'd1', subject: 'New' }, { creates, records: { d1: tagged } })
    // An edit rewrites the message, so without this the draft comes back untagged.
    expect(creates[0]?.keywords).toEqual(['$label:Invoices'])
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
    expect(text).toContain('previous draft d1 could not be removed')
    // The leftover holds the pre-edit content and is still sendable, so the note
    // has to say which id to send.
    expect(text).toContain('PRE-EDIT content')
    expect(text).toContain('send d2')
  })
})
