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

  test('lists every attached file with the blobId a later call needs', async () => {
    const staged = stagedDraft({
      attachments: [
        { blobId: 'Ginvoice', name: 'invoice.pdf', size: 2048, type: 'application/pdf' },
        { blobId: 'Gnote', name: 'note.txt', size: 12, type: 'text/plain' },
      ],
    })
    const { text } = await run({ draftId: 'd1' }, { records: { d1: staged } })
    expect(text).toContain('attachments (2):')
    // Size included, so a human reviewing the draft sees the whole thing; the
    // blobId is what update_draft needs to keep the file across an edit.
    expect(text).toContain('1. invoice.pdf — application/pdf — 2.0 KB — blobId: Ginvoice')
    expect(text).toContain('2. note.txt — text/plain — 12 B — blobId: Gnote')
  })

  test('still reports a file it cannot re-attach, rather than showing the draft as empty-handed', async () => {
    // The part is dropped from the composable model (no blobId to reference),
    // but the draft carries it and send_draft would deliver it — so the surface
    // a human reviews the draft on must not claim there is nothing attached.
    const staged = stagedDraft({ attachments: [{ name: 'scan.pdf', size: 4096, type: 'application/pdf' }] })
    const { text } = await run({ draftId: 'd1' }, { records: { d1: staged } })
    expect(text).toContain('attachments (1):')
    expect(text).toContain('scan.pdf')
    expect(text).toContain('cannot be re-attached')
  })

  test('counts referencable and unreferencable files together', async () => {
    const staged = stagedDraft({
      attachments: [
        { blobId: 'Ginvoice', name: 'invoice.pdf', size: 2048, type: 'application/pdf' },
        { name: 'scan.pdf', size: 4096, type: 'application/pdf' },
      ],
    })
    const { text } = await run({ draftId: 'd1' }, { records: { d1: staged } })
    expect(text).toContain('attachments (2):')
    expect(text).toContain('1. invoice.pdf — application/pdf — 2.0 KB — blobId: Ginvoice')
    expect(text).toContain('2. scan.pdf')
  })

  test('says nothing about attachments when there are none', async () => {
    const { text } = await run({ draftId: 'd1' }, { records: { d1: stagedDraft() } })
    expect(text).not.toContain('attachments')
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
