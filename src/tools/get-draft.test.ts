import { describe, expect, test } from 'bun:test'

import { type DraftDepsOptions, draftDeps, stagedDraft } from './draft-test-fixtures.ts'
import { getDraft, getDraftInput } from './get-draft.ts'

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await getDraft(draftDeps(opts), { args: getDraftInput.parse(args), token: 'tok' })
  return { result, text: result.content[0]?.text ?? '' }
}

describe('getDraft', () => {
  test('reads the staged fields back, bcc included', async () => {
    const staged = stagedDraft({ bcc: [{ email: 'quiet@example.org' }], cc: [{ email: 'carl@example.org' }] })
    const { text } = await run({ draftId: 'd1' }, { records: { d1: staged } })
    expect(text).toContain('Draft (not sent):')
    expect(text).toContain('draftId: d1')
    expect(text).toContain('to: nadia@example.org')
    expect(text).toContain('cc: carl@example.org')
    // get_email never shows bcc, which is exactly why this tool exists.
    expect(text).toContain('bcc: quiet@example.org')
    expect(text).toContain('subject: Quarterly numbers')
    expect(text).toContain('body (text): Here they are.')
  })

  test('errors on an unknown id', async () => {
    const { result, text } = await run({ draftId: 'gone' })
    expect(result.isError).toBe(true)
    expect(text).toContain('Draft not found: gone')
  })

  test('points at get_email for a message that is not a draft', async () => {
    const sent = stagedDraft({ keywords: { $seen: true }, mailboxIds: { mbSent: true } })
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: sent } })
    expect(result.isError).toBe(true)
    expect(text).toContain('is not a draft')
    expect(text).toContain('get_email')
  })
})
