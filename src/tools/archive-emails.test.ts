import { describe, expect, test } from 'bun:test'

import { archiveEmails } from './archive-emails.ts'
import { fakeDeps } from './file-emails-test-fixtures.ts'

describe('archiveEmails', () => {
  test('adds the Archive mailbox and drops Inbox in one patch over all ids', async () => {
    const deps = fakeDeps()
    const result = await archiveEmails(deps, { args: { ids: ['m1', 'm2'] }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Archived 2 message(s).')
    expect(deps.patches).toEqual([
      { changes: { mailboxIds: { 'mb-archive': true, 'mb-inbox': false } }, ids: ['m1', 'm2'] },
    ])
    expect(deps.replacements).toHaveLength(0)
  })

  test('reports ids the server refused without failing the batch', async () => {
    const deps = fakeDeps({ missing: ['m2'] })
    const result = await archiveEmails(deps, { args: { ids: ['m1', 'm2'] }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Archived 1 message(s).')
    expect(result.content[0]?.text).toContain('Not updated (1): m2 (notFound)')
  })

  test('errors without writing when the account has no Archive mailbox', async () => {
    const deps = fakeDeps({ places: { archive: null } })
    const result = await archiveEmails(deps, { args: { ids: ['m1'] }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no Archive mailbox')
    expect(result.content[0]?.text).toContain('move_emails')
    expect(deps.patches).toHaveLength(0)
  })

  test('still archives when the account has no Inbox role (only adds Archive)', async () => {
    const deps = fakeDeps({ places: { inbox: null } })
    await archiveEmails(deps, { args: { ids: ['m1'] }, token: 'tok' })
    expect(deps.patches[0]?.changes).toEqual({ mailboxIds: { 'mb-archive': true } })
  })
})
