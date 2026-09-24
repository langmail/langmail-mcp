import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ACCOUNT_WRITE } from './annotations.ts'
import { type FakeFileEmailsDeps, fakeDeps } from './file-emails-test-fixtures.ts'
import { moveEmails, moveEmailsInput, registerMoveEmails } from './move-emails.ts'
import { type ToolResult } from './result.ts'

// Counts the two lookups so a test can assert a refusal short-circuited before
// the round-trip it was meant to skip.
const countingDeps = (
  opts?: Parameters<typeof fakeDeps>[0]
): { calls: { resolveMailbox: number; resolvePlaces: number }; deps: FakeFileEmailsDeps } => {
  const inner = fakeDeps(opts)
  const calls = { resolveMailbox: 0, resolvePlaces: 0 }
  return {
    calls,
    deps: {
      ...inner,
      resolveMailbox: (token, name) => {
        calls.resolveMailbox += 1
        return inner.resolveMailbox(token, name)
      },
      resolvePlaces: (token) => {
        calls.resolvePlaces += 1
        return inner.resolvePlaces(token)
      },
    },
  }
}

describe('moveEmailsInput', () => {
  test('collapses duplicate ids and requires a mailbox', () => {
    expect(moveEmailsInput.parse({ ids: ['m1', 'm1'], mailbox: 'Projects' }).ids).toEqual(['m1'])
    expect(moveEmailsInput.safeParse({ ids: ['m1'] }).success).toBe(false)
    expect(moveEmailsInput.safeParse({ ids: ['m1'], mailbox: '' }).success).toBe(false)
  })
})

describe('moveEmails', () => {
  test('replaces the mailbox set with the destination for every id', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1', 'm2'], mailbox: 'Projects' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Moved 2 message(s) to Projects.')
    expect(deps.replacements).toEqual([{ ids: ['m1', 'm2'], mailboxId: 'mb-projects' }])
    expect(deps.patches).toHaveLength(0)
  })

  test('resolves place names case-insensitively through the shared resolver', async () => {
    const deps = fakeDeps()
    await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'inbox' }, token: 'tok' })
    expect(deps.replacements[0]?.mailboxId).toBe('mb-inbox')
  })

  test('reports ids the server refused without failing the batch', async () => {
    const deps = fakeDeps({ missing: ['m2'] })
    const result = await moveEmails(deps, { args: { ids: ['m1', 'm2'], mailbox: 'Projects' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Moved 1 message(s) to Projects.')
    expect(result.content[0]?.text).toContain('Not updated (1): m2 (notFound)')
  })

  test('errors with the available folders on an unknown name and writes nothing', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Projcets' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Mailbox not found: Projcets')
    expect(result.content[0]?.text).toContain('Projects')
    expect(deps.replacements).toHaveLength(0)
  })

  test('refuses the Trash mailbox under any name and points at trash_emails', async () => {
    // The refusal compares resolved ids, so a server that calls its trash-role
    // mailbox "Deleted Items" cannot slip past the non-destructive tool.
    const deps = fakeDeps({ folders: { 'Deleted Items': 'mb-trash' } })
    for (const mailbox of ['Trash', 'bin', 'Deleted Items']) {
      const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox }, token: 'tok' })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('trash_emails')
      expect(result.content[0]?.text).toContain('Nothing was moved')
    }
    expect(deps.replacements).toHaveLength(0)
  })

  test('refuses a role-less folder named Trash when the account has no trash role', async () => {
    const deps = fakeDeps({ folders: { Trash: 'mb-roleless-trash' }, places: { trash: null } })
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Trash' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('trash_emails')
    expect(deps.replacements).toHaveLength(0)
  })

  test('resolves Archive by role as a plain move destination', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Archive' }, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(deps.replacements[0]?.mailboxId).toBe('mb-archive')
  })

  test('reports the destination the caller spelled, not the folder it resolved to', async () => {
    const deps = fakeDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'InBoX' }, token: 'tok' })
    expect(result.content[0]?.text).toBe('Moved 1 message(s) to InBoX.')
    expect(deps.replacements[0]?.mailboxId).toBe('mb-inbox')
  })

  test('fails the batch when the server refused every id and says where fresh ids come from', async () => {
    const deps = fakeDeps({ missing: ['m1', 'm2'] })
    const result = await moveEmails(deps, { args: { ids: ['m1', 'm2'], mailbox: 'Projects' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Moved 0 message(s) to Projects.')
    expect(result.content[0]?.text).toContain('Not updated (2): m1 (notFound), m2 (notFound)')
    expect(result.content[0]?.text).toContain('Re-run search_emails or get_thread for current ids.')
    // The write still went out — refusing the ids was the server's call, not this tool's.
    expect(deps.replacements).toEqual([{ ids: ['m1', 'm2'], mailboxId: 'mb-projects' }])
  })

  test('omits the available-folders clause when the listing came back empty', async () => {
    const deps = { ...fakeDeps(), resolveMailbox: () => Promise.resolve({ available: [], id: null }) }
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Projects' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('Mailbox not found: Projects. Nothing was moved.')
  })

  test('refuses a trash place name before it looks anything up', async () => {
    const { calls, deps } = countingDeps()
    const result = await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Bin' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(calls).toEqual({ resolveMailbox: 0, resolvePlaces: 0 })
  })

  test('skips the places round-trip when the destination name resolves to nothing', async () => {
    const { calls, deps } = countingDeps()
    await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Projcets' }, token: 'tok' })
    expect(calls).toEqual({ resolveMailbox: 1, resolvePlaces: 0 })
  })

  test('hands the caller token to every dependency it reaches', async () => {
    const tokens: string[] = []
    const inner = fakeDeps()
    const deps: FakeFileEmailsDeps = {
      ...inner,
      replaceMailboxes: (token, ids, mailboxId) => {
        tokens.push(token)
        return inner.replaceMailboxes(token, ids, mailboxId)
      },
      resolveMailbox: (token, name) => {
        tokens.push(token)
        return inner.resolveMailbox(token, name)
      },
      resolvePlaces: (token) => {
        tokens.push(token)
        return inner.resolvePlaces(token)
      },
    }
    await moveEmails(deps, { args: { ids: ['m1'], mailbox: 'Projects' }, token: 'tok-live' })
    expect(tokens).toEqual(['tok-live', 'tok-live', 'tok-live'])
  })
})

describe('moveEmailsInput bounds', () => {
  test('caps the batch at 50 ids, counted before duplicates collapse', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `m${i}`)
    expect(moveEmailsInput.parse({ ids: fifty, mailbox: 'Projects' }).ids).toHaveLength(50)
    expect(moveEmailsInput.safeParse({ ids: [...fifty, 'm50'], mailbox: 'Projects' }).success).toBe(false)
    // 51 copies of one id collapse to 1, but the cap has already rejected them.
    expect(
      moveEmailsInput.safeParse({ ids: Array.from({ length: 51 }, () => 'm1'), mailbox: 'Projects' }).success
    ).toBe(false)
  })

  test('rejects an empty id, an empty batch, and an over-long mailbox name', () => {
    expect(moveEmailsInput.safeParse({ ids: [''], mailbox: 'Projects' }).success).toBe(false)
    expect(moveEmailsInput.safeParse({ ids: [], mailbox: 'Projects' }).success).toBe(false)
    expect(moveEmailsInput.safeParse({ ids: ['m1'], mailbox: 'p'.repeat(200) }).success).toBe(true)
    expect(moveEmailsInput.safeParse({ ids: ['m1'], mailbox: 'p'.repeat(201) }).success).toBe(false)
  })

  test('keeps first-seen order when collapsing duplicates', () => {
    expect(moveEmailsInput.parse({ ids: ['m2', 'm1', 'm2'], mailbox: 'Projects' }).ids).toEqual(['m2', 'm1'])
  })
})

interface RegisteredConfig {
  annotations?: unknown
  description?: string
  inputSchema?: Record<string, unknown>
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

describe('registerMoveEmails', () => {
  test('registers move_emails as a non-destructive account write', () => {
    const { configs, registered, server } = makeServer()
    registerMoveEmails(server, fakeDeps(), () => 'tok')

    expect([...registered.keys()]).toEqual(['move_emails'])
    const config = configs.get('move_emails')
    // The whole reason Trash is refused above: this tool claims it destroys nothing.
    expect(config?.annotations).toEqual(ACCOUNT_WRITE)
    expect(config?.title).toBe('Move emails')
    expect(config?.description).toContain('trash_emails')
    expect(Object.keys(config?.inputSchema ?? {}).sort()).toEqual(['ids', 'mailbox'])
  })

  test('parses the raw args, collapsing duplicates, and moves them', async () => {
    const deps = fakeDeps()
    const { registered, server } = makeServer()
    registerMoveEmails(server, deps, () => 'tok')

    const result = (await registered.get('move_emails')?.({
      ids: ['m1', 'm1', 'm2'],
      mailbox: 'Projects',
    })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('Moved 2 message(s) to Projects.')
    expect(deps.replacements).toEqual([{ ids: ['m1', 'm2'], mailboxId: 'mb-projects' }])
  })

  test('reads the token afresh on every call', async () => {
    const { registered, server } = makeServer()
    let issued = 0
    const tokens: string[] = []
    const inner = fakeDeps()
    const deps: FakeFileEmailsDeps = {
      ...inner,
      replaceMailboxes: (token, ids, mailboxId) => {
        tokens.push(token)
        return inner.replaceMailboxes(token, ids, mailboxId)
      },
    }
    registerMoveEmails(server, deps, () => {
      issued += 1
      return `tok-${issued}`
    })

    await registered.get('move_emails')?.({ ids: ['m1'], mailbox: 'Projects' })
    await registered.get('move_emails')?.({ ids: ['m2'], mailbox: 'Projects' })

    expect(tokens).toEqual(['tok-1', 'tok-2'])
  })

  test('surfaces the Trash refusal through the registered callback', async () => {
    const deps = fakeDeps()
    const { registered, server } = makeServer()
    registerMoveEmails(server, deps, () => 'tok')

    const result = (await registered.get('move_emails')?.({ ids: ['m1'], mailbox: 'Trash' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('trash_emails')
    expect(deps.replacements).toHaveLength(0)
  })

  test('throws on invalid args instead of returning an error result', () => {
    // Current behaviour: this wrapper uses `.parse`, so a bad argument escapes
    // as a ZodError rather than the `errorResult` the safeParse-based writers
    // (e.g. update_mail_rule) return. Recorded, not endorsed.
    const deps = fakeDeps()
    const { registered, server } = makeServer()
    registerMoveEmails(server, deps, () => 'tok')

    expect(() => registered.get('move_emails')?.({ ids: ['m1'] })).toThrow()
    expect(() => registered.get('move_emails')?.({ ids: [], mailbox: 'Projects' })).toThrow()
    expect(deps.replacements).toHaveLength(0)
  })
})
