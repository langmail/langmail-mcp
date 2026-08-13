// Shared fakes for the contact write tools: an in-memory address book that
// behaves like ContactCard/set well enough to exercise the tools end to end
// (create → read back → patch → read back), so each test asserts on stored
// state rather than on the shape of the patch it happened to produce.

import { COLLECTED_NOTE_KEY, collectedNoteEntry } from '@langmail/contacts'
import { type AddressBookRecord, type ContactCard, type ContactCardDraft } from '@langmail/jmap'

import { type ContactWriteDeps } from './contact-common.ts'

export interface FakeBook {
  books: AddressBookRecord[]
  cards: Map<string, ContactCard>
  deps: ContactWriteDeps
  patches: Record<string, unknown>[]
}

// RFC 8620 §5.3 PatchObject, narrowed to what the tools emit: a top-level
// property replacement, or one `a/b` path setting or removing a nested key.
const applyPatch = (card: ContactCard, patch: Record<string, unknown>): ContactCard => {
  const next = { ...card } as Record<string, unknown>
  for (const [path, value] of Object.entries(patch)) {
    const [head, key] = path.split('/')
    if (key === undefined) {
      next[path] = value
      continue
    }
    const parent = next[head as string]
    if (typeof parent !== 'object' || parent === null) {
      throw new Error(`patch path ${path} has no parent`)
    }
    const copy = { ...(parent as Record<string, unknown>) }
    if (value === null) {
      delete copy[key]
    } else {
      copy[key] = value
    }
    next[head as string] = copy
  }
  return next as unknown as ContactCard
}

export const fakeBook = (seed: ContactCard[] = [], books?: AddressBookRecord[]): FakeBook => {
  const state: FakeBook = {
    books: books ?? [{ id: 'ab-default', isDefault: true, name: 'Personal' }],
    cards: new Map(seed.map((c) => [c.id, c])),
    deps: {} as ContactWriteDeps,
    patches: [],
  }
  let n = 0
  state.deps = {
    addressBookCreate: ({ name }) => {
      const book = { id: `ab-${state.books.length}`, name }
      state.books.push(book)
      return Promise.resolve(book.id)
    },
    addressBookList: () => Promise.resolve(state.books),
    contactCardCreate: ({ card }: { card: ContactCardDraft }) => {
      n += 1
      const id = `card-${n}`
      state.cards.set(id, { ...card, id })
      return Promise.resolve(id)
    },
    contactCardDestroy: ({ cardId }) => {
      state.cards.delete(cardId)
      return Promise.resolve()
    },
    contactCardGet: ({ ids }) =>
      Promise.resolve(ids.flatMap((id) => (state.cards.has(id) ? [state.cards.get(id) as ContactCard] : []))),
    // RFC 9610 §5.5: the `email` condition matches when the given string is
    // *contained in* an address, not when it equals one. Modelled faithfully
    // here, because a caller that mistakes it for an exact lookup rejects
    // ann@example.com on the strength of a stored joann@example.com.
    contactCardQuery: ({ filter }) => {
      const wanted = (filter as { email?: string } | undefined)?.email?.toLowerCase()
      if (!wanted) {
        return Promise.resolve([...state.cards.keys()])
      }
      return Promise.resolve(
        [...state.cards.values()]
          .filter((c) => Object.values(c.emails ?? {}).some((e) => e.address.toLowerCase().includes(wanted)))
          .map((c) => c.id)
      )
    },
    contactCardUpdate: ({ cardId, patch }) => {
      const card = state.cards.get(cardId)
      if (!card) {
        throw new Error(`no card ${cardId}`)
      }
      state.patches.push(patch)
      state.cards.set(cardId, applyPatch(card, patch))
      return Promise.resolve()
    },
    resolveAccountId: () => Promise.resolve('acct'),
  }
  return state
}

// A card as the collection fold would have left it: derived, one work
// address, no authored fields.
export const derivedCard = (over: Partial<ContactCard> = {}): ContactCard => ({
  addressBookIds: { collected: true },
  emails: { e0: { address: 'robin@northwind.example', contexts: { work: true } } },
  id: 'card-robin',
  name: { full: 'Robin Fairweather' },
  notes: {
    [COLLECTED_NOTE_KEY]: collectedNoteEntry({
      addresses: {
        'robin@northwind.example': {
          confidence: 'strong',
          count: 2,
          firstSeen: '2026-06-01T09:00:00Z',
          lastSeen: '2026-07-01T09:00:00Z',
        },
      },
      interactions: [],
      source: 'derived',
    }),
  },
  ...over,
})
