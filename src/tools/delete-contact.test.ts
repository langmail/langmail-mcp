import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { COLLECTED_NOTE_KEY, collectedNoteEntry } from '@langmail/contacts'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { derivedCard, fakeBook } from './contact-test-fixtures.ts'
import { deleteContact, deleteContactInput, registerDeleteContact } from './delete-contact.ts'
import { type ToolResult } from './result.ts'

const args = deleteContactInput.parse({ contactId: 'card-robin' })

describe('deleteContact', () => {
  test('destroys the card and says the deletion propagates over CardDAV', async () => {
    const book = fakeBook([derivedCard()])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(book.cards.size).toBe(0)
    expect(result.content[0]?.text).toContain('Robin Fairweather')
    expect(result.content[0]?.text).toContain('CardDAV')
  })

  test('a derived card is a reset, not a suppression — the result says so', async () => {
    const book = fakeBook([derivedCard()])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.content[0]?.text).toContain('will collect them again')
  })

  test('an authored card does not come back, and the result says that instead', async () => {
    const book = fakeBook([
      derivedCard({
        notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'authored' }) },
      }),
    ])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.content[0]?.text).toContain('nothing will bring it back')
  })

  test('an unknown id points at search_contacts and destroys nothing', async () => {
    const book = fakeBook([derivedCard()])
    const result = await deleteContact(book.deps, {
      args: deleteContactInput.parse({ contactId: 'card-nope' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('search_contacts')
    expect(book.cards.size).toBe(1)
  })

  test('a card with no collection marker counts as imported and says it stays gone', async () => {
    // No COLLECTED_NOTE_KEY note at all: the card predates Langmail's own
    // writes, so `sourceOf` falls back to `imported`.
    const book = fakeBook([derivedCard({ notes: {} })])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('will not come back on its own')
    expect(book.cards.size).toBe(0)
  })

  test('labels a nameless card by its first email address', async () => {
    const book = fakeBook([derivedCard({ name: undefined })])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.content[0]?.text).toContain('"robin@northwind.example"')
  })

  test('falls back to the contact id when the card has neither name nor address', async () => {
    const book = fakeBook([derivedCard({ emails: undefined, name: undefined })])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.content[0]?.text).toContain('"card-robin"')
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

describe('registerDeleteContact', () => {
  test('registers delete_contact as an account-destructive tool', () => {
    const { configs, registered, server } = makeServer()
    registerDeleteContact(server, fakeBook([derivedCard()]).deps, () => 'tok')

    expect([...registered.keys()]).toEqual(['delete_contact'])
    const config = configs.get('delete_contact')
    expect(config?.annotations).toEqual(ACCOUNT_DESTRUCTIVE)
    expect(config?.title).toBe('Delete contact')
    expect(config?.description).toContain('search_contacts')
  })

  test('parses valid args, passes the current token through, and destroys the card', async () => {
    const book = fakeBook([derivedCard()])
    const { registered, server } = makeServer()
    const tokens: string[] = []
    registerDeleteContact(server, book.deps, () => {
      tokens.push('tok-live')
      return 'tok-live'
    })

    const result = (await registered.get('delete_contact')?.({ contactId: 'card-robin' })) as ToolResult

    expect(result.isError).toBeUndefined()
    expect(book.cards.size).toBe(0)
    expect(tokens).toEqual(['tok-live'])
  })

  test('reports an unknown id through the tool result rather than throwing', async () => {
    const book = fakeBook([derivedCard()])
    const { registered, server } = makeServer()
    registerDeleteContact(server, book.deps, () => 'tok')

    const result = (await registered.get('delete_contact')?.({ contactId: 'card-nope' })) as ToolResult

    expect(result.isError).toBe(true)
    expect(book.cards.size).toBe(1)
  })

  test('throws on invalid args instead of returning an error result', () => {
    // Current behaviour: this wrapper uses `.parse`, so a bad argument escapes
    // as a ZodError rather than the `errorResult` the safeParse-based writers
    // (e.g. update_mail_rule) return. Recorded, not endorsed.
    const book = fakeBook([derivedCard()])
    const { registered, server } = makeServer()
    registerDeleteContact(server, book.deps, () => 'tok')

    expect(() => registered.get('delete_contact')?.({ contactId: '' })).toThrow()
    expect(book.cards.size).toBe(1)
  })
})
