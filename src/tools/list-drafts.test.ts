import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/server'

import { type DraftListParams } from '@langmail/jmap'

import { READ_ONLY } from './annotations.ts'
import { type DraftToolDeps } from './draft-common.ts'
import { type DraftDepsOptions, draftDeps, receivedMessage, stagedDraft } from './draft-test-fixtures.ts'
import { listDrafts, listDraftsInput, registerListDrafts } from './list-drafts.ts'
import { type ToolResult } from './result.ts'

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}, deps = draftDeps(opts)) => {
  const result = await listDrafts(deps, { args: listDraftsInput.parse(args), token: 'tok' })
  return { result, text: result.content[0]?.text ?? '' }
}

// The fixture answers listings but doesn't record them, and the filter this
// tool sends is load-bearing — so wrap the one method and keep the params.
const recordingDeps = (opts: DraftDepsOptions, lists: DraftListParams[]): DraftToolDeps => {
  const base = draftDeps(opts)
  return {
    ...base,
    draftList: (p) => {
      lists.push(p)
      return base.draftList(p)
    },
  }
}

const older = stagedDraft({ receivedAt: '2026-10-06T09:00:00Z' })
const newer = stagedDraft({
  id: 'd7',
  keywords: { $draft: true, $seen: true, '$draftid:tok7': true },
  receivedAt: '2026-10-07T12:00:00Z',
  subject: 'Invoice 42',
  to: [{ email: 'billing@example.com', name: 'Billing' }],
})

describe('listDraftsInput schema', () => {
  test('takes no required arguments and defaults the limit', () => {
    expect(listDraftsInput.parse({}).limit).toBe(20)
  })

  test('rejects a blank query, a limit over 50, and a non-UTC date', () => {
    expect(listDraftsInput.safeParse({ query: '   ' }).success).toBe(false)
    expect(listDraftsInput.safeParse({ limit: 51 }).success).toBe(false)
    expect(listDraftsInput.safeParse({ after: '2026-10-01' }).success).toBe(false)
  })
})

describe('listDrafts', () => {
  test('lists every staged draft newest first, each with the ids the other tools take', async () => {
    const { result, text } = await run({}, { records: { d1: older, d7: newer } })
    expect(result.isError).toBeUndefined()
    expect(text).toContain('2 draft(s) (not sent), newest first:')
    // The stable draftId, not the revision's JMAP id: that is what get_draft,
    // update_draft and send_draft resolve.
    expect(text.indexOf('1. draftId: tok7')).toBeLessThan(text.indexOf('2. draftId: d1'))
    // The message id is what trash_emails needs to discard it.
    expect(text).toContain('   messageId: d7')
    expect(text).toContain('   last staged: 2026-10-07T12:00:00Z')
    expect(text).toContain('   to: Billing <billing@example.com>')
    expect(text).toContain('   subject: Invoice 42')
    expect(text).toContain('   body (text): Here they are.')
  })

  test('shows bcc and attachments, the parts of a draft no other listing reveals', async () => {
    const staged = stagedDraft({
      attachments: [{ blobId: 'Ginvoice', name: 'invoice.pdf', size: 2048, type: 'application/pdf' }],
      bcc: [{ email: 'quiet@example.org' }],
    })
    const { text } = await run({}, { records: { d1: staged } })
    expect(text).toContain('   bcc: quiet@example.org')
    expect(text).toContain('   attachments (1):')
    expect(text).toContain('invoice.pdf — application/pdf — 2.0 KB — blobId: Ginvoice')
  })

  test('names the message a reply draft answers', async () => {
    const reply = stagedDraft({
      inReplyTo: ['orig@example.org'],
      keywords: { $draft: true, $seen: true, '$draftid:d1': true, '$draftreplyto:e1': true },
    })
    const { text } = await run({}, { records: { d1: reply, e1: receivedMessage() } })
    expect(text).toContain('   reply to: message e1 (read it with get_email)')
    expect(text).toContain('threading: In-Reply-To/References set')
  })

  test('leaves out a draft another client left in Trash as well as Drafts', async () => {
    const both = stagedDraft({ id: 'd2', mailboxIds: { mbDrafts: true, mbTrash: true } })
    const { text } = await run({}, { records: { d1: older, d2: both } })
    expect(text).toContain('1 draft(s)')
    expect(text).not.toContain('messageId: d2')
  })

  test('leaves out sent mail, trashed drafts, and anything without $draft', async () => {
    const trashed = stagedDraft({ id: 'd2', mailboxIds: { mbTrash: true } })
    const sent = stagedDraft({ id: 'd3', keywords: { $seen: true }, mailboxIds: { mbSent: true } })
    const filedByHand = stagedDraft({ id: 'd4', keywords: { $seen: true } })
    const { text } = await run({}, { records: { d1: older, d2: trashed, d3: sent, d4: filedByHand } })
    expect(text).toContain('1 draft(s)')
    expect(text).not.toContain('messageId: d2')
    expect(text).not.toContain('messageId: d3')
    expect(text).not.toContain('messageId: d4')
  })

  test('passes the filters through and reads only a preview-sized body', async () => {
    const lists: DraftListParams[] = []
    await run(
      { after: '2026-10-01T00:00:00Z', before: '2026-10-08T00:00:00Z', limit: 5, query: 'invoice' },
      {},
      recordingDeps({ records: { d1: older } }, lists)
    )
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({
      after: '2026-10-01T00:00:00Z',
      before: '2026-10-08T00:00:00Z',
      excludeMailboxId: 'mbTrash',
      limit: 5,
      mailboxId: 'mbDrafts',
      maxBodyValueBytes: 2000,
      text: 'invoice',
    })
  })

  test('matches the query against recipients as well as the subject', async () => {
    const { text } = await run({ query: 'billing@example.com' }, { records: { d1: older, d7: newer } })
    expect(text).toContain('1 draft(s)')
    expect(text).toContain('draftId: tok7')
  })

  test('says how many more drafts exist when the page is full', async () => {
    const { text } = await run({ limit: 1 }, { records: { d1: older, d7: newer } })
    expect(text).toContain('Showing the newest 1 of 2 draft(s) (not sent):')
    expect(text).toContain('1 more draft(s) not shown. Narrow with query or after/before, or raise limit.')
  })

  test('does not suggest raising the limit once it is at the cap', async () => {
    const records = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`d${i}`, stagedDraft({ id: `d${i}`, keywords: { $draft: true } })])
    )
    const { text } = await run({ limit: 50 }, { records })
    expect(text).toContain('1 more draft(s) not shown. Narrow with query or after/before.')
  })

  test('matches whole words, not fragments of one, like the server', async () => {
    expect((await run({ query: 'invo' }, { records: { d7: newer } })).text).toBe('No drafts matched.')
    expect((await run({ query: 'invoice' }, { records: { d7: newer } })).text).toContain('draftId: tok7')
    expect((await run({ query: 'example.com' }, { records: { d7: newer } })).text).toContain('draftId: tok7')
  })

  test('tells an empty folder apart from a filter that matched nothing', async () => {
    expect((await run({})).text).toBe('The Drafts folder is empty.')
    expect((await run({ query: 'nothing' }, { records: { d1: older } })).text).toBe('No drafts matched.')
  })

  test('refuses on an account with no Drafts folder', async () => {
    const { result, text } = await run({}, { mailboxes: { drafts: null, sent: 'mbSent', trash: 'mbTrash' } })
    expect(result.isError).toBe(true)
    expect(text).toContain('no Drafts folder')
  })
})

describe('registerListDrafts', () => {
  test('registers list_drafts as read-only', async () => {
    let registered: { config: { annotations: unknown }; handler: (args: unknown) => Promise<ToolResult> } | undefined
    const server = {
      registerTool: (
        name: string,
        config: { annotations: unknown },
        handler: (args: unknown) => Promise<ToolResult>
      ) => {
        expect(name).toBe('list_drafts')
        registered = { config, handler }
      },
    } as unknown as McpServer
    registerListDrafts(server, draftDeps({ records: { d1: older } }), () => 'tok')
    expect(registered?.config.annotations).toEqual(READ_ONLY)
    const result = await registered?.handler({})
    expect(result?.content[0]?.text).toContain('draftId: d1')
  })
})
