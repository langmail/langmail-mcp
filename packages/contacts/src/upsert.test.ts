import { describe, expect, test } from 'bun:test'

import { type ContactCard, type ContactCardDraft, ContactUidTakenError } from '@langmail/jmap'

import { COLLECTED_BOOK_NAME, COLLECTED_PATCH_PATH } from './constants.ts'
import { type CollectionDeps, collectContacts } from './upsert.ts'

const CTX = { accountId: 'acct', apiUrl: 'https://mail.example.com/jmap/', authorization: 'Basic x' }

interface Captured {
  bookCreates: string[]
  cardCreates: ContactCardDraft[]
  cardDestroys: string[]
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
  contactCardDestroy: (p) => {
    captured.cardDestroys.push(p.cardId)
    return Promise.resolve()
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
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
    await collectContacts(makeDeps(captured), CTX, { observations: [observation], relays: [] })
    expect(captured.bookCreates).toEqual([COLLECTED_BOOK_NAME])
    expect(captured.cardCreates).toHaveLength(1)
    expect(captured.cardCreates[0]?.addressBookIds).toEqual({ 'book-new': true })
  })

  test('reuses an existing collected book and queries by address, collected uid and name', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
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
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
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
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
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
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
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
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
    const deps = makeDeps(captured)
    deps.contactCardCreate = () => Promise.reject(new Error('socket closed'))
    await expect(collectContacts(deps, CTX, { observations: [observation], relays: [] })).rejects.toThrow(
      'socket closed'
    )
  })

  describe('a personal card duplicating a Collected card', () => {
    const books = [{ id: 'book-c', name: COLLECTED_BOOK_NAME }]
    const collectedCard = {
      addressBookIds: { 'book-c': true },
      emails: { e0: { address: 'robin@northwind.example' } },
      id: 'card-collected',
      name: { full: 'Robin Fairweather' },
      uid: 'urn:langmail:collected:robin@northwind.example',
    } as ContactCard
    const personalCard = {
      addressBookIds: { 'book-personal': true },
      emails: { e0: { address: 'robin@northwind.example' } },
      id: 'card-personal',
      name: { full: 'Robin Fairweather' },
    } as ContactCard

    test('updates the personal card, then destroys the Collected card', async () => {
      const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
      const order: string[] = []
      const deps = makeDeps(captured, { books, cards: [collectedCard, personalCard] })
      deps.contactCardUpdate = (p) => {
        order.push(`update ${p.cardId}`)
        return Promise.resolve()
      }
      deps.contactCardDestroy = (p) => {
        order.push(`destroy ${p.cardId}`)
        return Promise.resolve()
      }
      await collectContacts(deps, CTX, { observations: [observation], relays: [] })
      expect(order).toEqual(['update card-personal', 'destroy card-collected'])
    })

    test('a failed update of the personal card leaves both cards', async () => {
      const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
      const deps = makeDeps(captured, { books, cards: [collectedCard, personalCard] })
      deps.contactCardUpdate = () => Promise.reject(new Error('stateMismatch'))
      await expect(collectContacts(deps, CTX, { observations: [observation], relays: [] })).rejects.toThrow(
        'stateMismatch'
      )
      expect(captured.cardDestroys).toEqual([])
    })

    test("also fetches the owners of the Collected card's other addresses", async () => {
      const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
      const twin = { ...collectedCard, emails: { ...collectedCard.emails, e1: { address: 'robin@home.example' } } }
      const other = { ...personalCard, emails: { e0: { address: 'robin@home.example' } }, id: 'card-other' }
      const deps = makeDeps(captured, { books, cards: [twin, personalCard] })
      deps.contactCardQuery = (p) => {
        captured.queries.push(p.filter)
        return Promise.resolve(captured.queries.length === 1 ? [twin.id, personalCard.id] : [other.id])
      }
      deps.contactCardGet = (p) =>
        Promise.resolve([twin, personalCard, other].filter((c) => p.ids.includes(c.id)) as ContactCard[])
      await collectContacts(deps, CTX, { observations: [observation], relays: [] })
      expect(captured.queries[1]).toEqual({ conditions: [{ email: 'robin@home.example' }], operator: 'OR' })
      // card-other already holds the second address, so the Collected card
      // stays rather than splitting its history between two cards.
      expect(captured.cardDestroys).toEqual([])
    })

    test('a failed destroy does not cost the rest of the batch its updates', async () => {
      const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
      const sam = {
        addressBookIds: { 'book-personal': true },
        emails: { e0: { address: 'sam@northwind.example' } },
        id: 'card-sam',
        name: { full: 'Sam Lowe' },
      } as ContactCard
      const deps = makeDeps(captured, { books, cards: [collectedCard, personalCard, sam] })
      deps.contactCardDestroy = () => Promise.reject(new Error('rateLimit'))
      await collectContacts(deps, CTX, {
        observations: [observation, { ...observation, address: 'sam@northwind.example', name: 'Sam Lowe' }],
        relays: [],
      })
      expect(captured.cardUpdates.map((u) => u.cardId).sort()).toEqual(['card-personal', 'card-sam'])
    })

    // Index lag: the `email` condition misses the freshly imported personal
    // card, while the `uid` condition still finds the Collected one. The
    // observation lands on the Collected card; nothing new is created, and
    // the next batch that sees both cards merges them.
    test('when the email lookup misses the personal card, no second Collected card appears', async () => {
      const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
      await collectContacts(makeDeps(captured, { books, cards: [collectedCard] }), CTX, {
        observations: [observation],
        relays: [],
      })
      expect(captured.cardCreates).toEqual([])
      expect(captured.cardDestroys).toEqual([])
      expect(captured.cardUpdates.map((u) => u.cardId)).toEqual(['card-collected'])
    })
  })

  test('does nothing without observations', async () => {
    const captured: Captured = { bookCreates: [], cardCreates: [], cardDestroys: [], cardUpdates: [], queries: [] }
    await collectContacts(makeDeps(captured), CTX, {
      observations: [],
      relays: [{ address: 'noreply@x.example', recordId: 'm1' }],
    })
    expect(captured.queries).toEqual([])
    expect(captured.bookCreates).toEqual([])
  })
})
