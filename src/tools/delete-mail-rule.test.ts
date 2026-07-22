import { describe, expect, test } from 'bun:test'

import { type MailRule } from '../rules/rule.ts'
import { type MailRulesStore } from '../rules/store.ts'
import { deleteMailRule } from './delete-mail-rule.ts'

const rules: MailRule[] = [
  {
    actions: { moveTo: 'Archive' },
    conditions: { from: 'notifications@github.com' },
    description: 'Automatically archive all GitHub notifications',
    id: 'rule-1a2b3c4d',
  },
  {
    actions: { markRead: true },
    conditions: { subject: 'calendar invitation' },
    description: 'Mark calendar invitations as read',
    id: 'rule-99999999',
  },
]

const fakeStore = (): MailRulesStore & { rules: MailRule[]; saves: number } => {
  const store = {
    load: () => Promise.resolve([...store.rules]),
    rules: [...rules],
    save: (_t: string, next: MailRule[]) => {
      store.saves += 1
      store.rules = next
      return Promise.resolve()
    },
    saves: 0,
  }
  return store
}

describe('deleteMailRule', () => {
  test('removes exactly the named rule and confirms with its description', async () => {
    const store = fakeStore()
    const result = await deleteMailRule(store, { args: { ruleId: 'rule-1a2b3c4d' }, token: 'tok' })
    expect(store.rules.map((r) => r.id)).toEqual(['rule-99999999'])
    expect(result.content[0]?.text).toContain('Automatically archive all GitHub notifications')
    expect(result.isError).toBeUndefined()
  })

  test('errors without writing when the id is unknown', async () => {
    const store = fakeStore()
    const result = await deleteMailRule(store, { args: { ruleId: 'rule-nope' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('list_mail_rules')
    expect(store.saves).toBe(0)
  })
})
