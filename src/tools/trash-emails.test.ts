import { describe, expect, test } from 'bun:test'

import { fakeDeps } from './file-emails-test-fixtures.ts'
import { trashEmails } from './trash-emails.ts'

describe('trashEmails', () => {
  test('replaces the mailbox set with Trash for every id', async () => {
    const deps = fakeDeps()
    const result = await trashEmails(deps, { args: { ids: ['m1', 'm2'] }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Trashed 2 message(s).')
    expect(deps.replacements).toEqual([{ ids: ['m1', 'm2'], mailboxId: 'mb-trash' }])
    expect(deps.patches).toHaveLength(0)
  })

  test('reports ids the server refused without failing the batch', async () => {
    const deps = fakeDeps({ missing: ['m2'] })
    const result = await trashEmails(deps, { args: { ids: ['m1', 'm2'] }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Trashed 1 message(s).')
    expect(result.content[0]?.text).toContain('Not updated (1): m2 (notFound)')
  })

  test('errors without writing when the account has no Trash mailbox', async () => {
    const deps = fakeDeps({ places: { trash: null } })
    const result = await trashEmails(deps, { args: { ids: ['m1'] }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no Trash mailbox')
    expect(deps.replacements).toHaveLength(0)
  })
})
