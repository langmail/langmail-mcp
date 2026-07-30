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

  test('admits when the superseded draft could not be removed', async () => {
    const { text } = await run(
      { draftId: 'd1', text: 'hi' },
      { created: { id: 'd2', replacedDestroyed: false, threadId: null }, records: { d1: stagedDraft() } }
    )
    expect(text).toContain('previous draft d1 could not be removed')
  })
})
