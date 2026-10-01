import { describe, expect, test } from 'bun:test'

import { fakeDeps } from './file-emails-test-fixtures.ts'
import { markEmails, markEmailsInput } from './mark-emails.ts'

describe('markEmails', () => {
  test('adds $seen in one keyword patch over all ids when marking read', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { as: 'read', ids: ['m1', 'm2'] }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Marked 2 message(s) as read.')
    expect(deps.patches).toEqual([{ changes: { keywords: { $seen: true } }, ids: ['m1', 'm2'] }])
    expect(deps.replacements).toHaveLength(0)
  })

  test('drops $seen when marking unread and leaves mailboxes alone', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { as: 'unread', ids: ['m1'] }, token: 'tok' })
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as unread.')
    expect(deps.patches[0]?.changes).toEqual({ keywords: { $seen: false } })
  })

  test('reports ids the server refused without failing the batch', async () => {
    const deps = fakeDeps({ missing: ['m2'] })
    const result = await markEmails(deps, { args: { as: 'read', ids: ['m1', 'm2'] }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as read. Not updated (1): m2 (notFound).')
  })

  test('errors when no id was updated', async () => {
    const deps = fakeDeps({ missing: ['m1'] })
    const result = await markEmails(deps, { args: { as: 'read', ids: ['m1'] }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('search_emails')
  })
})

describe('markEmailsInput', () => {
  test('collapses duplicate ids', () => {
    expect(markEmailsInput.parse({ as: 'read', ids: ['m1', 'm1', 'm2'] }).ids).toEqual(['m1', 'm2'])
  })

  test('rejects anything but read or unread', () => {
    expect(markEmailsInput.safeParse({ as: 'flagged', ids: ['m1'] }).success).toBe(false)
  })
})
