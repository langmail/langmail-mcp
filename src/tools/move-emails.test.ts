import { describe, expect, test } from 'bun:test'

import { fakeDeps } from './file-emails-test-fixtures.ts'
import { moveEmails, moveEmailsInput } from './move-emails.ts'

describe('moveEmailsInput', () => {
  test('collapses duplicate ids and requires a mailbox', () => {
    expect(moveEmailsInput.parse({ ids: ['m1', 'm1'], mailbox: 'Projects' }).ids).toEqual(['m1'])
    expect(moveEmailsInput.safeParse({ ids: ['m1'] }).success).toBe(false)
    expect(moveEmailsInput.safeParse({ ids: ['m1'], mailbox: '' }).success).toBe(false)
  })
})

describe('moveEmails', () => {
  test('replaces the mailbox set with the destination for every id', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1', 'm2'], mailbox: 'Projects' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Moved 2 message(s) to Projects.')
    expect(deps.replacements).toEqual([{ ids: ['m1', 'm2'], mailboxId: 'mb-projects' }])
    expect(deps.patches).toHaveLength(0)
  })

  test('resolves place names case-insensitively through the shared resolver', async () => {
    const deps = fakeDeps()
    await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'inbox' }, token: 'tok' })
    expect(deps.replacements[0]?.mailboxId).toBe('mb-inbox')
  })

  test('reports ids the server refused without failing the batch', async () => {
    const deps = fakeDeps({ missing: ['m2'] })
    const result = await moveEmails(deps, { args: { ids: ['m1', 'm2'], mailbox: 'Projects' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Moved 1 message(s) to Projects.')
    expect(result.content[0]?.text).toContain('Not updated (1): m2 (notFound)')
  })

  test('errors with the available folders on an unknown name and writes nothing', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Projcets' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Mailbox not found: Projcets')
    expect(result.content[0]?.text).toContain('Projects')
    expect(deps.replacements).toHaveLength(0)
  })

  test('refuses the Trash mailbox under any name and points at trash_emails', async () => {
    // The refusal compares resolved ids, so a server that calls its trash-role
    // mailbox "Deleted Items" cannot slip past the non-destructive tool.
    const deps = fakeDeps({ folders: { 'Deleted Items': 'mb-trash' } })
    for (const mailbox of ['Trash', 'bin', 'Deleted Items']) {
      const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox }, token: 'tok' })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('trash_emails')
      expect(result.content[0]?.text).toContain('Nothing was moved')
    }
    expect(deps.replacements).toHaveLength(0)
  })

  test('refuses a role-less folder named Trash when the account has no trash role', async () => {
    const deps = fakeDeps({ folders: { Trash: 'mb-roleless-trash' }, places: { trash: null } })
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Trash' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('trash_emails')
    expect(deps.replacements).toHaveLength(0)
  })

  test('resolves Archive by role as a plain move destination', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Archive' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(deps.replacements[0]?.mailboxId).toBe('mb-archive')
  })
})
