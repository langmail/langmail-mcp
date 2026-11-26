import { describe, expect, test } from 'bun:test'

import { createLocalMailRuleInput, createMailRule, createMailRuleInput } from './create-mail-rule.ts'
import { fakeDeps, githubRule, NOW } from './mail-rule-test-fixtures.ts'

const RULE_ID_RE = /^rule-[0-9a-f]{8}$/

const args = {
  actions: [{ type: 'archive' as const }, { tag: 'GitHub', type: 'addTag' as const }],
  conditions: { from: 'notifications@github.com' },
  match: 'all' as const,
  name: 'Archive GitHub Notifications',
}

describe('createMailRuleInput schema', () => {
  test('requires at least one condition and one action', () => {
    expect(createMailRuleInput.safeParse(args).success).toBe(true)
    expect(createMailRuleInput.safeParse({ ...args, conditions: {} }).success).toBe(false)
    expect(createMailRuleInput.safeParse({ ...args, actions: [] }).success).toBe(false)
  })

  test('accepts hasAttachment:false as "not set" instead of rejecting it', () => {
    const parsed = createMailRuleInput.safeParse({
      ...args,
      conditions: { from: 'x', hasAttachment: false },
    })
    expect(parsed.success).toBe(true)
  })

  test('defaults match to all and rejects a non-email forward target', () => {
    const parsed = createMailRuleInput.parse({ actions: args.actions, conditions: args.conditions })
    expect(parsed.match).toBe('all')
    expect(
      createMailRuleInput.safeParse({ ...args, actions: [{ to: 'not-an-address', type: 'forward' }] }).success
    ).toBe(false)
  })
})

describe('createMailRule', () => {
  test('appends an enabled rule with fresh id + timestamps and does not touch existing mail by default', async () => {
    const deps = fakeDeps()
    const result = await createMailRule(deps, { args: createMailRuleInput.parse(args), token: 'tok' })
    expect(deps.saves).toBe(1)
    expect(deps.applies).toHaveLength(0)
    const rule = deps.rules[0]
    expect(rule?.id).toMatch(RULE_ID_RE)
    expect(rule?.enabled).toBe(true)
    expect(rule?.createdAt).toBe(NOW)
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('future incoming messages')
    expect(txt).toContain('existing messages are untouched')
    expect(txt).toContain(rule?.id ?? '')
  })

  test('normalizes hasAttachment:false out of the stored conditions', async () => {
    const deps = fakeDeps()
    await createMailRule(deps, {
      args: createMailRuleInput.parse({ ...args, conditions: { from: 'x', hasAttachment: false } }),
      token: 'tok',
    })
    expect(deps.rules[0]?.conditions).toEqual({ from: 'x' })
  })

  test('applies to existing mail when requested and reports the summary', async () => {
    const deps = fakeDeps()
    const result = await createMailRule(deps, {
      args: createMailRuleInput.parse({ ...args, existingMail: { mode: 'messages', scope: 'inbox' } }),
      token: 'tok',
    })
    expect(deps.applies).toHaveLength(1)
    expect(deps.applies[0]?.mode).toBe('messages')
    expect(deps.applies[0]?.scope).toBe('inbox')
    expect(deps.applies[0]?.rule).toEqual(deps.rules[0] ?? ({} as never))
    expect(result.content[0]?.text).toContain('Applied to existing mail: 2 messages matched, 2 modified.')
  })

  test('a large backfill without confirmation creates nothing and asks to confirm', async () => {
    const deps = fakeDeps([], { estimate: { capped: false, conversations: 300, messages: 450 } })
    const result = await createMailRule(deps, {
      args: createMailRuleInput.parse({ ...args, existingMail: { mode: 'messages' } }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('450')
    expect(result.content[0]?.text).toContain('confirmLargeApply')
    expect(deps.saves).toBe(0)
    expect(deps.applies).toHaveLength(0)
  })

  test('the same large backfill goes through with confirmLargeApply: true', async () => {
    const deps = fakeDeps([], { estimate: { capped: false, conversations: 300, messages: 450 } })
    const result = await createMailRule(deps, {
      args: createMailRuleInput.parse({ ...args, existingMail: { confirmLargeApply: true, mode: 'messages' } }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    expect(deps.saves).toBe(1)
    expect(deps.applies).toHaveLength(1)
  })

  test('keeps existing rules and assigns a distinct id', async () => {
    const existing = githubRule()
    const deps = fakeDeps([existing])
    await createMailRule(deps, { args: createMailRuleInput.parse(args), token: 'tok' })
    expect(deps.rules).toHaveLength(2)
    expect(deps.rules[0]).toEqual(existing)
    expect(deps.rules[1]?.id).not.toBe(existing.id)
  })
})

describe('createLocalMailRuleInput (Change, never send)', () => {
  test('accepts every action but forward', () => {
    expect(createLocalMailRuleInput.safeParse(args).success).toBe(true)
    expect(createLocalMailRuleInput.safeParse({ ...args, actions: [{ type: 'stopProcessing' }] }).success).toBe(true)
    expect(
      createLocalMailRuleInput.safeParse({ ...args, actions: [{ to: 'someone@example.com', type: 'forward' }] }).success
    ).toBe(false)
  })

  test('still requires a condition', () => {
    expect(createLocalMailRuleInput.safeParse({ ...args, conditions: {} }).success).toBe(false)
  })
})
