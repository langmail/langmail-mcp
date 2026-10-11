import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { deleteMailRule, registerDeleteMailRule } from './delete-mail-rule.ts'
import { fakeDeps, githubRule } from './mail-rule-test-fixtures.ts'
import { type ToolResult } from './result.ts'

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

  test('names the missing id in the error so the caller can tell which lookup failed', async () => {
    const deps = fakeDeps([githubRule()])
    const result = await deleteMailRule(deps, { args: { ruleId: 'rule-nope' }, token: 'tok' })
    expect(result.content[0]?.text).toContain('rule-nope')
  })

  test('confirms a nameless rule by id alone, without an empty quoted title', async () => {
    const deps = fakeDeps([githubRule({ name: undefined })])
    const result = await deleteMailRule(deps, { args: { ruleId: 'rule-00000001' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Deleted mail rule rule-00000001.')
    expect(result.content[0]?.text).not.toContain('""')
  })

  test('saves an empty rule set when the last rule goes, so the Sieve script is regenerated', async () => {
    const deps = fakeDeps([githubRule()])
    await deleteMailRule(deps, { args: { ruleId: 'rule-00000001' }, token: 'tok' })
    expect(deps.saves).toBe(1)
    expect(deps.rules).toEqual([])
  })

  test('says processed mail is left alone', async () => {
    const deps = fakeDeps([githubRule()])
    const result = await deleteMailRule(deps, { args: { ruleId: 'rule-00000001' }, token: 'tok' })
    expect(result.content[0]?.text).toContain('already processed is unchanged')
  })

  test('does not run the applier — deletion never touches existing mail', async () => {
    const deps = fakeDeps([githubRule()])
    await deleteMailRule(deps, { args: { ruleId: 'rule-00000001' }, token: 'tok' })
    expect(deps.applies).toEqual([])
  })
})

interface RegisteredConfig {
  annotations?: unknown
  description?: string
  title?: string
}

type Registered = (args: unknown) => unknown

// A stand-in for the one method the registration wrapper calls, so the test
// drives the registered tool callback directly instead of through a transport.
const makeServer = (): {
  configs: Map<string, RegisteredConfig>
  registered: Map<string, Registered>
  server: McpServer
} => {
  const configs = new Map<string, RegisteredConfig>()
  const registered = new Map<string, Registered>()
  const server = {
    registerTool: (name: string, config: RegisteredConfig, cb: Registered) => {
      configs.set(name, config)
      registered.set(name, cb)
      return { name }
    },
  } as unknown as McpServer
  return { configs, registered, server }
}

describe('registerDeleteMailRule', () => {
  test('registers delete_mail_rule as an account-destructive tool', () => {
    const { configs, registered, server } = makeServer()
    registerDeleteMailRule(server, fakeDeps([githubRule()]), () => 'tok')

    expect([...registered.keys()]).toEqual(['delete_mail_rule'])
    const config = configs.get('delete_mail_rule')
    expect(config?.annotations).toEqual(ACCOUNT_DESTRUCTIVE)
    expect(config?.title).toBe('Delete mail rule')
    expect(config?.description).toContain('list_mail_rules')
    expect(config?.description).toContain('update_mail_rule')
  })

  test('parses valid args, passes the current token through, and removes the rule', async () => {
    const deps = fakeDeps([githubRule()])
    const { registered, server } = makeServer()
    const tokens: string[] = []
    registerDeleteMailRule(server, deps, () => {
      tokens.push('tok-live')
      return 'tok-live'
    })

    const result = (await registered.get('delete_mail_rule')?.({ ruleId: 'rule-00000001' })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(deps.rules).toEqual([])
    expect(tokens).toEqual(['tok-live'])
  })

  test('reports an unknown id through the tool result rather than throwing', async () => {
    const deps = fakeDeps([githubRule()])
    const { registered, server } = makeServer()
    registerDeleteMailRule(server, deps, () => 'tok')

    const result = (await registered.get('delete_mail_rule')?.({ ruleId: 'rule-nope' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(deps.saves).toBe(0)
  })

  test('throws on invalid args instead of returning an error result', () => {
    // Current behaviour: this wrapper uses `.parse`, so a bad argument escapes
    // as a ZodError rather than the `errorResult` the safeParse-based writers
    // (e.g. update_mail_rule) return. Recorded, not endorsed.
    const deps = fakeDeps([githubRule()])
    const { registered, server } = makeServer()
    registerDeleteMailRule(server, deps, () => 'tok')

    expect(() => registered.get('delete_mail_rule')?.({ ruleId: '' })).toThrow()
    expect(deps.rules.map((r) => r.id)).toEqual(['rule-00000001'])
  })
})
