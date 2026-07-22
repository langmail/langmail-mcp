import { describe, expect, test } from 'bun:test'

import { deleteMailRule } from './delete-mail-rule.ts'
import { fakeDeps, githubRule } from './mail-rule-test-fixtures.ts'

describe('deleteMailRule', () => {
  test('removes exactly the named rule and confirms with its name', async () => {
    const deps = fakeDeps([githubRule(), githubRule({ id: 'rule-00000002', name: 'Second' })])
    const result = await deleteMailRule(deps, { args: { ruleId: 'rule-00000001' }, token: 'tok' })
    expect(deps.rules.map((r) => r.id)).toEqual(['rule-00000002'])
    expect(result.content[0]?.text).toContain('Archive GitHub Notifications')
    expect(result.isError).toBeUndefined()
  })

  test('errors without writing when the id is unknown', async () => {
    const deps = fakeDeps([githubRule()])
    const result = await deleteMailRule(deps, { args: { ruleId: 'rule-nope' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('list_mail_rules')
    expect(deps.saves).toBe(0)
  })
})
