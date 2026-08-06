import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { fakeDeps, githubRule } from './mail-rule-test-fixtures.ts'
import { type ToolResult } from './result.ts'
import { registerUpdateMailRule, updateMailRule, updateMailRuleInput } from './update-mail-rule.ts'

type Registered = (args: unknown) => unknown

// A stand-in for the one method the registration wrapper calls, so the test
// drives the registered tool callback directly instead of through a transport.
const makeServer = (): { registered: Map<string, Registered>; server: McpServer } => {
  const registered = new Map<string, Registered>()
  const server = {
    registerTool: (name: string, _config: unknown, cb: Registered) => {
      registered.set(name, cb)
      return { name }
    },
  } as unknown as McpServer
  return { registered, server }
}

describe('updateMailRuleInput schema', () => {
  test('requires the ruleId plus at least one updatable field', () => {
    expect(updateMailRuleInput.safeParse({ ruleId: 'rule-1' }).success).toBe(false)
    expect(updateMailRuleInput.safeParse({ enabled: false, ruleId: 'rule-1' }).success).toBe(true)
  })

  test('rejects replacement conditions with no condition set', () => {
    expect(updateMailRuleInput.safeParse({ conditions: {}, ruleId: 'rule-1' }).success).toBe(false)
  })
})

describe('updateMailRule', () => {
  test('replaces only the provided parts, preserves id/createdAt, bumps updatedAt', async () => {
    const original = githubRule({ createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' })
    const deps = fakeDeps([original])
    const result = await updateMailRule(deps, {
      args: updateMailRuleInput.parse({
        actions: [{ type: 'archive' }, { type: 'markRead' }],
        ruleId: original.id,
      }),
      token: 'tok',
    })
    expect(result.isError).toBeUndefined()
    const updated = deps.rules[0]
    expect(updated?.id).toBe(original.id)
    expect(updated?.createdAt).toBe('2026-07-01T00:00:00.000Z')
    expect(updated?.updatedAt).toBe('2026-07-22T12:00:00.000Z')
    expect(updated?.actions).toEqual([{ type: 'archive' }, { type: 'markRead' }])
    expect(updated?.conditions).toEqual(original.conditions)
    expect(result.content[0]?.text).toContain('mark as read')
  })

  test('enabled:false disables without deleting', async () => {
    const deps = fakeDeps([githubRule()])
    await updateMailRule(deps, {
      args: updateMailRuleInput.parse({ enabled: false, ruleId: 'rule-00000001' }),
      token: 'tok',
    })
    expect(deps.rules).toHaveLength(1)
    expect(deps.rules[0]?.enabled).toBe(false)
  })

  test('errors without writing when the id is unknown', async () => {
    const deps = fakeDeps([githubRule()])
    const result = await updateMailRule(deps, {
      args: updateMailRuleInput.parse({ enabled: false, ruleId: 'rule-nope' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('list_mail_rules')
    expect(deps.saves).toBe(0)
  })

  test('optionally applies the updated rule to existing mail', async () => {
    const deps = fakeDeps([githubRule()])
    const result = await updateMailRule(deps, {
      args: updateMailRuleInput.parse({
        actions: [{ type: 'markRead' }],
        existingMail: { mode: 'conversations', scope: 'all' },
        ruleId: 'rule-00000001',
      }),
      token: 'tok',
    })
    expect(deps.applies).toHaveLength(1)
    expect(deps.applies[0]?.mode).toBe('conversations')
    expect(deps.applies[0]?.scope).toBe('all')
    expect(deps.applies[0]?.rule).toEqual(deps.rules[0] ?? ({} as never))
    expect(result.content[0]?.text).toContain('Applied to existing mail')
  })

  test('a large backfill without confirmation updates nothing', async () => {
    const deps = fakeDeps([githubRule()], { estimate: { capped: false, conversations: 250, messages: 400 } })
    const result = await updateMailRule(deps, {
      args: updateMailRuleInput.parse({
        actions: [{ type: 'markRead' }],
        existingMail: { mode: 'messages' },
        ruleId: 'rule-00000001',
      }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(deps.saves).toBe(0)
    expect(deps.applies).toHaveLength(0)
  })
})

describe('registerUpdateMailRule', () => {
  test('registers under update_mail_rule and rejects invalid args without calling deps', async () => {
    const deps = fakeDeps([githubRule()])
    const { registered, server } = makeServer()
    registerUpdateMailRule(server, deps, () => 'tok')

    const result = (await registered.get('update_mail_rule')?.({ ruleId: 'rule-00000001' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(deps.saves).toBe(0)
  })

  test('parses valid args and delegates to updateMailRule', async () => {
    const deps = fakeDeps([githubRule()])
    const { registered, server } = makeServer()
    registerUpdateMailRule(server, deps, () => 'tok')

    const result = (await registered.get('update_mail_rule')?.({
      enabled: false,
      ruleId: 'rule-00000001',
    })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(deps.rules[0]?.enabled).toBe(false)
  })
})
