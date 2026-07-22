import { describe, expect, test } from 'bun:test'

import { type MailRule } from '../rules/rule.ts'
import { type MailRulesStore } from '../rules/store.ts'
import { createMailRule, createMailRuleInput } from './create-mail-rule.ts'

// A store over a mutable in-memory rule list, recording saves.
const fakeStore = (initial: MailRule[] = []): MailRulesStore & { rules: MailRule[]; saves: number } => {
  const store = {
    load: () => Promise.resolve([...store.rules]),
    rules: initial,
    save: (_t: string, rules: MailRule[]) => {
      store.saves += 1
      store.rules = rules
      return Promise.resolve()
    },
    saves: 0,
  }
  return store
}

const RULE_ID_RE = /^rule-[0-9a-f]{8}$/

const args = {
  actions: { moveTo: 'Archive' },
  conditions: { from: 'notifications@github.com' },
  description: 'Automatically archive all GitHub notifications',
}

describe('createMailRuleInput schema', () => {
  test('requires at least one condition and one action', () => {
    expect(createMailRuleInput.safeParse(args).success).toBe(true)
    expect(createMailRuleInput.safeParse({ ...args, conditions: {} }).success).toBe(false)
    expect(createMailRuleInput.safeParse({ ...args, actions: {} }).success).toBe(false)
  })

  test('rejects a non-email forwardTo', () => {
    expect(createMailRuleInput.safeParse({ ...args, actions: { forwardTo: 'not-an-address' } }).success).toBe(false)
  })
})

describe('createMailRule', () => {
  test('appends the rule with a fresh rule- id and confirms future-only semantics', async () => {
    const store = fakeStore()
    const result = await createMailRule(store, { args, token: 'tok' })
    expect(store.saves).toBe(1)
    expect(store.rules).toHaveLength(1)
    const rule = store.rules[0]
    expect(rule?.id).toMatch(RULE_ID_RE)
    expect(rule?.description).toBe(args.description)
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('future incoming messages')
    expect(txt).toContain(rule?.id ?? '')
    expect(txt).toContain('move to "Archive"')
  })

  test('keeps existing rules and assigns a distinct id', async () => {
    const existing: MailRule = {
      actions: { markRead: true },
      conditions: { subject: 'calendar invitation' },
      description: 'Mark calendar invitations as read',
      id: 'rule-00000000',
    }
    const store = fakeStore([existing])
    await createMailRule(store, { args, token: 'tok' })
    expect(store.rules).toHaveLength(2)
    expect(store.rules[0]).toEqual(existing)
    expect(store.rules[1]?.id).not.toBe(existing.id)
  })
})
