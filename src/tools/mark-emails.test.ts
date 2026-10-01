import { describe, expect, test } from 'bun:test'

import { fakeDeps } from './file-emails-test-fixtures.ts'
import { markEmails, markEmailsInput } from './mark-emails.ts'

describe('markEmails', () => {
  test('adds $seen in one keyword patch over all ids when marking read', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { ids: ['m1', 'm2'], read: true }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Marked 2 message(s) as read.')
    expect(deps.patches).toEqual([{ changes: { keywords: { $seen: true } }, ids: ['m1', 'm2'] }])
    expect(deps.replacements).toHaveLength(0)
  })

  test('drops $seen when marking unread and leaves mailboxes alone', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { ids: ['m1'], read: false }, token: 'tok' })
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as unread.')
    expect(deps.patches[0]?.changes).toEqual({ keywords: { $seen: false } })
  })

  test('sets the to-do label search_emails filters on', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { ids: ['m1'], todo: true }, token: 'tok' })
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as to-do.')
    expect(deps.patches[0]?.changes).toEqual({ keywords: { '$label:todo': true } })
  })

  test('stars and unstars through $flagged', async () => {
    const deps = fakeDeps()
    await markEmails(deps, { args: { ids: ['m1'], starred: true }, token: 'tok' })
    const result = await markEmails(deps, { args: { ids: ['m1'], starred: false }, token: 'tok' })
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as unstarred.')
    expect(deps.patches.map((p) => p.changes)).toEqual([
      { keywords: { $flagged: true } },
      { keywords: { $flagged: false } },
    ])
  })

  test('finishes a to-do and marks it read in one patch, naming both', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { ids: ['m1'], read: true, todo: false }, token: 'tok' })
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as read, not to-do.')
    expect(deps.patches).toEqual([{ changes: { keywords: { '$label:todo': false, $seen: true } }, ids: ['m1'] }])
  })

  test('refuses a call without any flag and writes nothing', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, { args: { ids: ['m1'] }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      'No flag given, so nothing was changed. Pass at least one of read, todo or starred.'
    )
    expect(deps.patches).toHaveLength(0)
  })

  test('reports ids the server refused without failing the batch', async () => {
    const deps = fakeDeps({ missing: ['m2'] })
    const result = await markEmails(deps, { args: { ids: ['m1', 'm2'], read: true }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as read. Not updated (1): m2 (notFound).')
  })

  test('errors when no id was updated', async () => {
    const deps = fakeDeps({ missing: ['m1'] })
    const result = await markEmails(deps, { args: { ids: ['m1'], read: true }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('search_emails')
  })
})

describe('markEmailsInput', () => {
  test('collapses duplicate ids', () => {
    expect(markEmailsInput.parse({ ids: ['m1', 'm1', 'm2'], read: true }).ids).toEqual(['m1', 'm2'])
  })

  test('rejects non-boolean flag values', () => {
    expect(markEmailsInput.safeParse({ ids: ['m1'], todo: 'yes' }).success).toBe(false)
  })
})
