import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { type EmailComposeRecord } from '@langmail/jmap'

import { createSendGuard } from '../drafts/send-guard.ts'
import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { deleteDraft, deleteDraftInput, registerDeleteDraft } from './delete-draft.ts'
import { type DraftDepsOptions, draftDeps, stagedDraft, TEST_PRINCIPAL } from './draft-test-fixtures.ts'
import { getDraft } from './get-draft.ts'

const call = (opts: DraftDepsOptions, draftId: string, guard = createSendGuard()) =>
  deleteDraft(draftDeps(opts), guard, {
    args: deleteDraftInput.parse({ draftId }),
    principal: TEST_PRINCIPAL,
    token: 'tok',
  })

const text = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? ''

describe('delete_draft', () => {
  test('destroys the current revision by stable id, after which get_draft finds nothing', async () => {
    // Edited once: `d1` is the superseded revision's JMAP id, `d2` the current one.
    const records: Record<string, EmailComposeRecord> = {
      d2: stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:tok1': true } }),
    }
    const destroys: string[] = []
    const result = await call({ destroys, records }, 'tok1')
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('Deleted draft tok1 ("Quarterly numbers", to nadia@example.org)')
    expect(destroys).toEqual(['d2'])

    const after = await getDraft(draftDeps({ records }), { args: { draftId: 'tok1' }, token: 'tok' })
    expect(after.isError).toBe(true)
    expect(text(after)).toContain('Draft not found')
  })

  test('deletes by the raw message id search_emails shows', async () => {
    const destroys: string[] = []
    const result = await call({ destroys, records: { d1: stagedDraft() } }, 'd1')
    expect(result.isError).toBeUndefined()
    expect(destroys).toEqual(['d1'])
  })

  test('refuses an unknown id and destroys nothing', async () => {
    const destroys: string[] = []
    const result = await call({ destroys, records: {} }, 'nope')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Draft not found: nope. Nothing was deleted.')
    expect(destroys).toEqual([])
  })

  test('refuses sent mail and destroys nothing', async () => {
    const destroys: string[] = []
    const sent = stagedDraft({ keywords: { $seen: true, '$draftid:d1': true }, mailboxIds: { mbSent: true } })
    const result = await call({ destroys, records: { d1: sent } }, 'd1')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('already been sent or received')
    expect(text(result)).toContain('Nothing was deleted.')
    expect(destroys).toEqual([])
  })

  test('deletes a draft that was moved to Trash', async () => {
    const destroys: string[] = []
    const trashed = stagedDraft({ mailboxIds: { mbTrash: true } })
    const result = await call({ destroys, records: { d1: trashed } }, 'd1')
    expect(result.isError).toBeUndefined()
    expect(destroys).toEqual(['d1'])
  })

  test('reports a destroy that lost the race as not found', async () => {
    const result = await call({ destroyResult: { notDestroyed: 'notFound' }, records: { d1: stagedDraft() } }, 'd1')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Draft not found: d1')
  })

  test('says so when the server neither destroyed nor refused the draft', async () => {
    const result = await call({ destroyResult: { notDestroyed: 'unknown' }, records: { d1: stagedDraft() } }, 'd1')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('did not say whether d1 was deleted')
  })

  test('a second delete while the first is running is refused without claiming a send', async () => {
    const destroys: string[] = []
    const guard = createSendGuard()
    const records = { d1: stagedDraft() }
    let release = (): void => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = draftDeps({ destroys, records })
    const deps = {
      ...base,
      resolveAccountId: async (a: string) => {
        await blocked
        return base.resolveAccountId(a)
      },
    }
    const ctx = { args: deleteDraftInput.parse({ draftId: 'd1' }), principal: TEST_PRINCIPAL, token: 'tok' }

    const first = deleteDraft(deps, guard, ctx)
    const second = await deleteDraft(deps, guard, ctx)
    release()
    expect((await first).isError).toBeUndefined()
    expect(second.isError).toBe(true)
    expect(text(second)).toContain('Another call is already working on d1')
    expect(text(second)).not.toContain('Sent')
    expect(destroys).toEqual(['d1'])
  })

  test('reports any other SetError as a refusal', async () => {
    const result = await call({ destroyResult: { notDestroyed: 'forbidden' }, records: { d1: stagedDraft() } }, 'd1')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('The server refused to delete d1 (forbidden). Nothing was deleted.')
  })

  test('refuses while a send of the draft is in flight', async () => {
    const destroys: string[] = []
    const guard = createSendGuard()
    // A send_draft holding the reservation on the draft's id.
    guard.reserve(TEST_PRINCIPAL, { key: 'd1', tool: 'send_draft' })
    const result = await call({ destroys, records: { d1: stagedDraft() } }, 'd1', guard)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was deleted.')
    expect(destroys).toEqual([])
  })

  test('refuses after a send through the other id whose outcome is unknown', async () => {
    const destroys: string[] = []
    const guard = createSendGuard()
    const tokenSubject = { key: 'tok1', tool: 'send_draft' }
    guard.reserve(TEST_PRINCIPAL, tokenSubject)
    guard.markUnknown(TEST_PRINCIPAL, tokenSubject)
    const edited = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:tok1': true } })
    const result = await call({ destroys, records: { d2: edited } }, 'd2', guard)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('failed without saying whether the message went out')
    expect(text(result)).toContain('Sent folder')
    expect(destroys).toEqual([])
    // Its own reservation is released, so a later delete is not blocked by it.
    expect(guard.reserve(TEST_PRINCIPAL, { key: 'd2', tool: 'send_draft' })).toBeNull()
  })

  test('refuses by stable id while a send holds the message id', async () => {
    const destroys: string[] = []
    const guard = createSendGuard()
    guard.reserve(TEST_PRINCIPAL, { key: 'd2', tool: 'send_draft' })
    const edited = stagedDraft({ id: 'd2', keywords: { $draft: true, $seen: true, '$draftid:tok1': true } })
    const result = await call({ destroys, records: { d2: edited } }, 'tok1', guard)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was deleted.')
    expect(destroys).toEqual([])
  })

  test('releases its reservation, so a later send is not blocked', async () => {
    const guard = createSendGuard()
    await call({ records: { d1: stagedDraft() } }, 'd1', guard)
    expect(guard.reserve(TEST_PRINCIPAL, { key: 'd1', tool: 'send_draft' })).toBeNull()
  })
})

describe('registerDeleteDraft', () => {
  test('registers delete_draft as an account-destructive tool that rejects an empty id', () => {
    const configs = new Map<string, { annotations?: unknown; title?: string }>()
    const callbacks = new Map<string, (args: unknown) => unknown>()
    const server = {
      registerTool: (name: string, config: { annotations?: unknown }, cb: (args: unknown) => unknown) => {
        configs.set(name, config)
        callbacks.set(name, cb)
        return { name }
      },
    } as unknown as McpServer
    registerDeleteDraft(
      server,
      draftDeps(),
      createSendGuard(),
      () => 'tok',
      () => TEST_PRINCIPAL
    )

    expect([...configs.keys()]).toEqual(['delete_draft'])
    expect(configs.get('delete_draft')?.annotations).toEqual(ACCOUNT_DESTRUCTIVE)
    expect(configs.get('delete_draft')?.title).toBe('Delete draft')
    expect(() => callbacks.get('delete_draft')?.({ draftId: '' })).toThrow()
  })
})
