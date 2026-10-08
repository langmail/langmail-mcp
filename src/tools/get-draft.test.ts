import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { type EmailComposeGetParams } from '@langmail/jmap'

import { READ_ONLY } from './annotations.ts'
import { type DraftToolDeps, MAX_DRAFT_BODY_VALUE_BYTES } from './draft-common.ts'
import { type DraftDepsOptions, draftDeps, stagedDraft } from './draft-test-fixtures.ts'
import { getDraft, getDraftInput, registerGetDraft } from './get-draft.ts'
import { type ToolResult } from './result.ts'

const run = async (args: Record<string, unknown>, opts: DraftDepsOptions = {}) => {
  const result = await getDraft(draftDeps(opts), { args: getDraftInput.parse(args), token: 'tok' })
  return { result, text: result.content[0]?.text ?? '' }
}

// The fixture answers reads but doesn't record them, and what this tool asks
// the server for is load-bearing — so wrap the one method and keep the params.
const recordingDeps = (opts: DraftDepsOptions, reads: EmailComposeGetParams[]): DraftToolDeps => {
  const base = draftDeps(opts)
  return {
    ...base,
    emailComposeGet: (p) => {
      reads.push(p)
      return base.emailComposeGet(p)
    },
  }
}

describe('getDraftInput schema', () => {
  test('requires a non-empty draftId', () => {
    expect(getDraftInput.safeParse({ draftId: 'd1' }).success).toBe(true)
    expect(getDraftInput.safeParse({ draftId: '' }).success).toBe(false)
    expect(getDraftInput.safeParse({}).success).toBe(false)
  })
})

describe('getDraft', () => {
  test('reads an edited draft by the id create_draft returned, and reports that id', async () => {
    const edited = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:d1': true } })
    const { result, text } = await run({ draftId: 'd1' }, { records: { d2: edited } })
    expect(result.isError).toBeUndefined()
    expect(text).toContain('draftId: d1')
  })

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

  test('treats a record carrying no keywords at all as not a draft', async () => {
    const { result, text } = await run({ draftId: 'd1' }, { records: { d1: stagedDraft({ keywords: undefined }) } })
    expect(result.isError).toBe(true)
    expect(text).toContain('d1 is not a draft')
  })

  test('reports the thread the draft is staged onto', async () => {
    const staged = stagedDraft({ threadId: 'tQ4' })
    const { text } = await run({ draftId: 'd1' }, { records: { d1: staged } })
    expect(text).toContain('threadId: tQ4')
  })

  test('reads with a bearer built from the call token and the full read-back budget', async () => {
    const reads: EmailComposeGetParams[] = []
    const deps = recordingDeps({ records: { d1: stagedDraft() } }, reads)
    await getDraft(deps, { args: getDraftInput.parse({ draftId: 'd1' }), token: 'tok-42' })

    expect(reads).toHaveLength(1)
    expect(reads[0]?.authorization).toBe('Bearer tok-42')
    expect(reads[0]?.id).toBe('d1')
    expect(reads[0]?.accountId).toBe('acct')
    // Reading a draft back at a smaller budget would truncate it, and
    // update_draft merges onto whatever this returns — so it asks for the
    // headroom cap, not the character cap the composition tools accept.
    expect(reads[0]?.maxBodyValueBytes).toBe(MAX_DRAFT_BODY_VALUE_BYTES)
  })
})

type Registered = (args: unknown) => unknown

interface RegisteredConfig {
  annotations?: unknown
  description?: string
  title?: string
}

// A stand-in for the one method the registration wrapper calls, so the test
// drives the registered tool callback directly instead of through a transport.
const makeServer = (): {
  configs: Map<string, RegisteredConfig>
  registered: Map<string, Registered>
  server: McpServer
} => {
  const configs = new Map<string, RegisteredConfig>()
  const registered = new Map<string, Registered>()
  const server = {
    registerTool: (name: string, config: RegisteredConfig, cb: Registered) => {
      configs.set(name, config)
      registered.set(name, cb)
      return { name }
    },
  } as unknown as McpServer
  return { configs, registered, server }
}

describe('registerGetDraft', () => {
  test('registers get_draft as a read-only tool', () => {
    const { configs, registered, server } = makeServer()
    registerGetDraft(server, draftDeps(), () => 'tok')

    expect([...registered.keys()]).toEqual(['get_draft'])
    const config = configs.get('get_draft')
    expect(config?.annotations).toEqual(READ_ONLY)
    expect(config?.title).toBe('Get draft')
    // The two promises the tool exists for: bcc is visible here and nowhere
    // else, and a sent message belongs to get_email instead.
    expect(config?.description).toContain('every recipient including bcc')
    expect(config?.description).toContain('use get_email')
  })

  test('parses the args and delegates with a bearer built from the current token', async () => {
    const reads: EmailComposeGetParams[] = []
    const deps = recordingDeps({ records: { d1: stagedDraft() } }, reads)
    const { registered, server } = makeServer()
    let token = 'stale-token'
    registerGetDraft(server, deps, () => token)
    // Rotate the token between registration and the call: the getter is read
    // per invocation, so caching it at registration would send the stale one.
    token = 'live-token'

    const result = (await registered.get('get_draft')?.({ draftId: 'd1' })) as ToolResult

    expect(reads[0]?.authorization).toBe('Bearer live-token')
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('draftId: d1')
    expect(result.content[0]?.text).toContain('subject: Quarterly numbers')
  })

  test('rejects args the schema refuses rather than reading with an empty id', () => {
    const reads: EmailComposeGetParams[] = []
    const { registered, server } = makeServer()
    registerGetDraft(server, recordingDeps({}, reads), () => 'tok')

    expect(() => registered.get('get_draft')?.({ draftId: '' })).toThrow()
    expect(reads).toEqual([])
  })
})
