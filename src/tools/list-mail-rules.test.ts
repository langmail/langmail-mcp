import { describe, expect, test } from 'bun:test'

import { type MailRule } from '../rules/rule.ts'
import { type MailRulesStore } from '../rules/store.ts'
import { listMailRules } from './list-mail-rules.ts'

const store = (rules: MailRule[]): MailRulesStore => ({
  load: () => Promise.resolve(rules),
  save: () => Promise.reject(new Error('list must not write')),
})

describe('listMailRules', () => {
  test('points at create_mail_rule when no rules exist', async () => {
    const result = await listMailRules(store([]), 'tok')
    expect(result.content[0]?.text).toContain('No mail rules configured')
  })

  test('renders id, description, conditions, and actions per rule', async () => {
    const result = await listMailRules(
      store([
        {
          actions: { moveTo: 'Archive' },
          conditions: { from: 'notifications@github.com' },
          description: 'Automatically archive all GitHub notifications',
          id: 'rule-1a2b3c4d',
        },
        {
          actions: { addTags: ['contracts'], forwardTo: 'legal@example.com' },
          conditions: { from: 'Acme Corp', hasAttachment: true },
          description: 'Tag and forward Acme contracts',
          id: 'rule-99999999',
        },
      ]),
      'tok'
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('2 mail rule(s)')
    expect(txt).toContain('1. [rule-1a2b3c4d] Automatically archive all GitHub notifications')
    expect(txt).toContain('when: sender contains "notifications@github.com"')
    expect(txt).toContain('then: move to "Archive"')
    expect(txt).toContain('sender contains "Acme Corp" AND has an attachment')
    expect(txt).toContain('add tag(s) "contracts"; forward a copy to legal@example.com')
  })
})
