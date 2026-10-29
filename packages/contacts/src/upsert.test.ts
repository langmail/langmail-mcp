import { describe, expect, test } from 'bun:test'

import { type ContactCard, type ContactCardDraft, ContactUidTakenError } from '@langmail/jmap'

import { COLLECTED_BOOK_NAME, COLLECTED_PATCH_PATH } from './constants.ts'
import { type CollectionDeps, collectContacts } from './upsert.ts'

const CTX = { accountId: 'acct', apiUrl: 'https://mail.example.com/jmap/', authorization: 'Basic x' }

interface Captured {
  bookCreates: string[]
  cardCreates: ContactCardDraft[]
  cardUpdates: { cardId: string; patch: Record<string, unknown> }[]
  queries: unknown[]
}

const makeDeps = (
  captured: Captured,
  opts: { books?: { id: string; name: string }[]; cards?: ContactCard[] } = {}
): CollectionDeps => ({
  addressBookCreate: (p) => {
    captured.bookCreates.push(p.name)
    return Promise.resolve('book-new')
  },
  addressBookList: () => Promise.resolve(opts.books ?? []),
  contactCardCreate: (p) => {
    captured.cardCreates.push(p.card)
    return Promise.resolve(`card-${captured.cardCreates.length}`)
  },
  contactCardGet: () => Promise.resolve(opts.cards ?? []),
  contactCardQuery: (p) => {
    captured.queries.push(p.filter)
    return Promise.resolve((opts.cards ?? []).map((c) => c.id))
  },
  contactCardUpdate: (p) => {
    captured.cardUpdates.push({ cardId: p.cardId, patch: p.patch })
    return Promise.resolve()
  },
})

const observation = {
  address: 'robin@northwind.example',
  channel: 'email' as const,
  confidence: 'strong' as const,
  date: '2026-07-20T12:00:00Z',
  direction: 'incoming' as const,
  name: 'Robin Fairweather',
  recordId: 'm1',
}

describe('collectContacts', () => {
  test('provisions the collected book lazily and creates the card there', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    await collectContacts(makeDeps(captured), CTX, { observations: [observation], relays: [] })
    expect(captured.bookCreates).toEqual([COLLECTED_BOOK_NAME])
    expect(captured.cardCreates).toHaveLength(1)
    expect(captured.cardCreates[0]?.addressBookIds).toEqual({ 'book-new': true })
  })

  test('reuses an existing collected book and queries by address, collected uid and name', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    await collectContacts(makeDeps(captured, { books: [{ id: 'book-c', name: COLLECTED_BOOK_NAME }] }), CTX, {
      observations: [observation],
      relays: [],
    })
    expect(captured.bookCreates).toEqual([])
    expect(captured.queries).toEqual([
      {
        conditions: [
          { email: 'robin@northwind.example' },
          { uid: 'urn:langmail:collected:robin@northwind.example' },
          { name: 'Robin Fairweather' },
        ],
        operator: 'OR',
      },
    ])
    expect(captured.cardCreates[0]?.addressBookIds).toEqual({ 'book-c': true })
  })

  test('updates an existing card instead of creating a duplicate', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    const existing = {
      addressBookIds: { 'book-personal': true },
      emails: { e0: { address: 'robin@northwind.example' } },
      id: 'card-9',
      name: { full: 'Robin Fairweather' },
    } as ContactCard
    await collectContacts(
      makeDeps(captured, { books: [{ id: 'book-c', name: COLLECTED_BOOK_NAME }], cards: [existing] }),
      CTX,
      { observations: [observation], relays: [] }
    )
    expect(captured.cardCreates).toEqual([])
    expect(captured.cardUpdates).toHaveLength(1)
    expect(captured.cardUpdates[0]?.cardId).toBe('card-9')
    // The fixture card carries no notes, so the payload arrives as a full
    // top-level set rather than the scoped path (see foldObservations).
    expect(captured.cardUpdates[0]?.patch.notes).toBeDefined()
    expect(captured.cardUpdates[0]?.patch[COLLECTED_PATCH_PATH]).toBeUndefined()
  })

  test('pages the candidate query until exhausted instead of truncating', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    const pageSize = 100
    const allIds = Array.from({ length: pageSize + 3 }, (_, i) => `card-${i}`)
    const deps = makeDeps(captured, { books: [{ id: 'book-c', name: COLLECTED_BOOK_NAME }] })
    deps.contactCardQuery = (p) => {
      captured.queries.push({ limit: p.limit, position: p.position })
      const start = p.position ?? 0
      return Promise.resolve(allIds.slice(start, start + (p.limit ?? pageSize)))
    }
    const fetched: string[][] = []
    deps.contactCardGet = (p) => {
      fetched.push(p.ids)
      return Promise.resolve([])
    }
    await collectContacts(deps, CTX, { observations: [observation], relays: [] })
    expect(captured.queries).toEqual([
      { limit: pageSize, position: 0 },
      { limit: pageSize, position: pageSize },
    ])
    expect(fetched[0]).toHaveLength(pageSize + 3)
  })

  // Two writers (the poller's batch and a calendar write-through) both miss a
  // new person and both create the collected card; Stalwart rejects the
  // second for its uid. That person is collected already, so the rest of the
  // batch goes on.
  test('skips a card whose uid a concurrent writer took, and collects the rest', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    const deps = makeDeps(captured)
    deps.contactCardCreate = (p) => {
      captured.cardCreates.push(p.card)
      return captured.cardCreates.length === 1
        ? Promise.reject(new ContactUidTakenError())
        : Promise.resolve(`card-${captured.cardCreates.length}`)
    }
    await collectContacts(deps, CTX, {
      observations: [observation, { ...observation, address: 'sam@northwind.example', name: 'Sam Lowe' }],
      relays: [],
    })
    expect(captured.cardCreates).toHaveLength(2)
  })

  test('still fails the batch on any other create error', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    const deps = makeDeps(captured)
    deps.contactCardCreate = () => Promise.reject(new Error('socket closed'))
    await expect(collectContacts(deps, CTX, { observations: [observation], relays: [] })).rejects.toThrow(
      'socket closed'
    )
  })

  test('does nothing without observations', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardUpdates: [], queries: [] }
    await collectContacts(makeDeps(captured), CTX, {
      observations: [],
      relays: [{ address: 'noreply@x.example', recordId: 'm1' }],
    })
    expect(captured.queries).toEqual([])
    expect(captured.bookCreates).toEqual([])
  })
})
