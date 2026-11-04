import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/server'

import { ACCOUNT_WRITE } from './annotations.ts'
import { type FakeFileEmailsDeps, fakeDeps } from './file-emails-test-fixtures.ts'
import { markEmails, markEmailsInput, registerMarkEmails } from './mark-emails.ts'
import { type ToolResult } from './result.ts'

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

  test('names the flags in the tool order, not the order the caller passed them', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, {
      args: { ids: ['m1'], read: true, starred: true, todo: true },
      token: 'tok',
    })
    expect(result.content[0]?.text).toBe('Marked 1 message(s) as read, to-do, starred.')
  })

  test('clears all three flags in a single patch', async () => {
    const deps = fakeDeps()
    const result = await markEmails(deps, {
      args: { ids: ['m1', 'm2'], read: false, starred: false, todo: false },
      token: 'tok',
    })
    expect(result.content[0]?.text).toBe('Marked 2 message(s) as unread, not to-do, unstarred.')
    expect(deps.patches).toEqual([
      { changes: { keywords: { $flagged: false, '$label:todo': false, $seen: false } }, ids: ['m1', 'm2'] },
    ])
  })

  test('leaves mailboxes untouched on every path', async () => {
    const deps = fakeDeps()
    await markEmails(deps, { args: { ids: ['m1'], starred: true }, token: 'tok' })
    await markEmails(deps, { args: { ids: ['m1'] }, token: 'tok' })
    expect(deps.replacements).toHaveLength(0)
  })

  test('forwards the caller token to the JMAP write unchanged', async () => {
    const inner = fakeDeps()
    const tokens: string[] = []
    const deps: FakeFileEmailsDeps = {
      ...inner,
      updateEmails: (token, ids, changes) => {
        tokens.push(token)
        return inner.updateEmails(token, ids, changes)
      },
    }
    await markEmails(deps, { args: { ids: ['m1'], read: true }, token: 'tok-abc' })
    expect(tokens).toEqual(['tok-abc'])
  })
})

describe('markEmailsInput', () => {
  test('collapses duplicate ids', () => {
    expect(markEmailsInput.parse({ ids: ['m1', 'm1', 'm2'], read: true }).ids).toEqual(['m1', 'm2'])
  })

  test('rejects non-boolean flag values', () => {
    expect(markEmailsInput.safeParse({ ids: ['m1'], todo: 'yes' }).success).toBe(false)
  })

  test('keeps first-seen order when collapsing duplicates', () => {
    expect(markEmailsInput.parse({ ids: ['m2', 'm1', 'm2'], read: true }).ids).toEqual(['m2', 'm1'])
  })

  test('rejects an empty id list and a blank id', () => {
    expect(markEmailsInput.safeParse({ ids: [], read: true }).success).toBe(false)
    expect(markEmailsInput.safeParse({ ids: [''], read: true }).success).toBe(false)
  })

  test('caps the batch at 50 ids as given, before duplicates collapse', () => {
    const unique = Array.from({ length: 50 }, (_, i) => `m${i}`)
    expect(markEmailsInput.safeParse({ ids: unique, read: true }).success).toBe(true)
    expect(markEmailsInput.safeParse({ ids: [...unique, 'm50'], read: true }).success).toBe(false)
    // 51 copies of one id collapse to a single message, and are still refused.
    expect(markEmailsInput.safeParse({ ids: Array.from({ length: 51 }, () => 'm1'), read: true }).success).toBe(false)
  })

  test('accepts a call with every flag set and one with none', () => {
    expect(markEmailsInput.safeParse({ ids: ['m1'], read: true, starred: false, todo: true }).success).toBe(true)
    // The "no flag given" refusal lives in markEmails, not the schema.
    expect(markEmailsInput.safeParse({ ids: ['m1'] }).success).toBe(true)
  })

  test('requires the ids field', () => {
    expect(markEmailsInput.safeParse({ read: true }).success).toBe(false)
  })
})

interface RegisteredConfig {
  annotations?: unknown
  description?: string
  inputSchema?: { shape: Record<string, unknown> }
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

describe('registerMarkEmails', () => {
  test('registers mark_emails as a non-destructive account write', () => {
    const { configs, registered, server } = makeServer()
    registerMarkEmails(server, fakeDeps(), () => 'tok')

    expect([...registered.keys()]).toEqual(['mark_emails'])
    const config = configs.get('mark_emails')
    expect(config?.annotations).toEqual(ACCOUNT_WRITE)
    expect(config?.title).toBe('Mark emails read, to-do or starred')
    // The tool points the agent at the filing tools rather than faking a move.
    expect(config?.description).toContain('archive_emails')
    expect(config?.description).toContain('move_emails')
  })

  test('advertises one field per flag and nothing for the system keywords', () => {
    const { configs, server } = makeServer()
    registerMarkEmails(server, fakeDeps(), () => 'tok')

    const schema = configs.get('mark_emails')?.inputSchema?.shape ?? {}
    expect(Object.keys(schema).sort()).toEqual(['ids', 'read', 'starred', 'todo'])
  })

  test('parses the raw args, collapsing duplicates, and marks them', async () => {
    const deps = fakeDeps()
    const { registered, server } = makeServer()
    registerMarkEmails(server, deps, () => 'tok')

    const result = (await registered.get('mark_emails')?.({
      ids: ['m1', 'm1', 'm2'],
      read: true,
    })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Marked 2 message(s) as read.')
    expect(deps.patches).toEqual([{ changes: { keywords: { $seen: true } }, ids: ['m1', 'm2'] }])
  })

  test('reads the token afresh on every call', async () => {
    const { registered, server } = makeServer()
    let issued = 0
    const tokens: string[] = []
    const inner = fakeDeps()
    const deps: FakeFileEmailsDeps = {
      ...inner,
      updateEmails: (token, ids, changes) => {
        tokens.push(token)
        return inner.updateEmails(token, ids, changes)
      },
    }
    registerMarkEmails(server, deps, () => {
      issued += 1
      return `tok-${issued}`
    })

    await registered.get('mark_emails')?.({ ids: ['m1'], read: true })
    await registered.get('mark_emails')?.({ ids: ['m2'], todo: true })

    expect(tokens).toEqual(['tok-1', 'tok-2'])
  })

  test('surfaces the no-flag refusal through the registered callback', async () => {
    const deps = fakeDeps()
    const { registered, server } = makeServer()
    registerMarkEmails(server, deps, () => 'tok')

    const result = (await registered.get('mark_emails')?.({ ids: ['m1'] })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Pass at least one of read, todo or starred.')
    expect(deps.patches).toHaveLength(0)
  })

  test('throws on invalid args instead of returning an error result', () => {
    // Current behaviour: this wrapper uses `.parse`, so a bad argument escapes
    // as a ZodError rather than the `errorResult` the safeParse-based writers
    // (e.g. update_mail_rule) return. Recorded, not endorsed.
    const deps = fakeDeps()
    const { registered, server } = makeServer()
    registerMarkEmails(server, deps, () => 'tok')

    expect(() => registered.get('mark_emails')?.({ ids: [], read: true })).toThrow()
    expect(() => registered.get('mark_emails')?.({ ids: ['m1'], read: 'yes' })).toThrow()
    expect(deps.patches).toHaveLength(0)
  })
})
