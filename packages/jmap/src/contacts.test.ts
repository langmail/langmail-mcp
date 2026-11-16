import { describe, expect, mock, test } from 'bun:test'

import {
  addressBookCreate,
  addressBookList,
  ContactUidTakenError,
  contactCardCreate,
  contactCardDestroy,
  contactCardGet,
  contactCardMerge,
  contactCardPage,
  contactCardQuery,
  contactCardUpdate,
} from './contacts.ts'
import { JmapError } from './session.ts'

const API = 'https://mail.example.com/jmap/'

const withFetch = <T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const jmapResponse = (methodResponses: unknown[]) => Response.json({ methodResponses }, { status: 200 })

describe('addressBookList', () => {
  test('sends AddressBook/get with ids:null under the contacts capability and parses the list', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(API)
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.using).toContain('urn:ietf:params:jmap:contacts')
      expect(body.methodCalls[0][0]).toBe('AddressBook/get')
      expect(body.methodCalls[0][1]).toEqual({ accountId: 'acct', ids: null })
      return Promise.resolve(
        jmapResponse([['AddressBook/get', { list: [{ id: 'ab1', isDefault: true, name: 'Default' }] }, '0']])
      )
    })
    const books = await withFetch(f, () =>
      addressBookList({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' })
    )
    expect(books).toEqual([{ id: 'ab1', isDefault: true, name: 'Default' }])
  })

  test('returns [] when the account has no books', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([['AddressBook/get', {}, '0']])))
    const books = await withFetch(f, () =>
      addressBookList({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' })
    )
    expect(books).toEqual([])
  })
})

describe('addressBookCreate', () => {
  test('creates a named book and returns the server-assigned id', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('AddressBook/set')
      expect(args.create.b0).toEqual({ name: 'Collected' })
      return Promise.resolve(jmapResponse([['AddressBook/set', { created: { b0: { id: 'ab9' } } }, '0']]))
    })
    const id = await withFetch(f, () =>
      addressBookCreate({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', name: 'Collected' })
    )
    expect(id).toBe('ab9')
  })

  test('throws a JmapError naming the notCreated type', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['AddressBook/set', { notCreated: { b0: { type: 'forbidden' } } }, '0']]))
    )
    await withFetch(f, async () => {
      const err = await addressBookCreate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        name: 'Collected',
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).message).toContain('forbidden')
    })
  })
})

describe('contactCardGet', () => {
  test('fetches the named ids without a properties filter (extension property must come back)', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('ContactCard/get')
      expect(args).toEqual({ accountId: 'acct', ids: ['c1'] })
      return Promise.resolve(
        jmapResponse([
          [
            'ContactCard/get',
            {
              list: [
                {
                  addressBookIds: { ab1: true },
                  emails: { e0: { address: 'robin@northwind.example', contexts: { work: true } } },
                  id: 'c1',
                  name: { full: 'Robin Fairweather' },
                  notes: { collected: { 'langmail.me:collected': { grade: 'confirmed' }, note: '' } },
                },
              ],
            },
            '0',
          ],
        ])
      )
    })
    const cards = await withFetch(f, () =>
      contactCardGet({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', ids: ['c1'] })
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]?.name?.full).toBe('Robin Fairweather')
    expect(cards[0]?.notes?.collected?.['langmail.me:collected']).toEqual({ grade: 'confirmed' })
  })

  test('short-circuits to [] on an empty id list without a request', async () => {
    const f = mock(() => Promise.resolve(jmapResponse([])))
    const cards = await withFetch(f, () =>
      contactCardGet({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', ids: [] })
    )
    expect(cards).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })
})

describe('contactCardPage', () => {
  test('queries a page and reads it narrowly through a #ids back-reference, in one request', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls).toEqual([
        ['ContactCard/query', { accountId: 'acct', calculateTotal: true, limit: 500, position: 1000 }, '0'],
        [
          'ContactCard/get',
          {
            '#ids': { name: 'ContactCard/query', path: '/ids', resultOf: '0' },
            accountId: 'acct',
            properties: ['id', 'name'],
          },
          '1',
        ],
      ])
      return Promise.resolve(
        jmapResponse([
          ['ContactCard/query', { ids: ['c2', 'c1', 'gone'], total: 1203 }, '0'],
          ['ContactCard/get', { list: [{ id: 'c1' }, { id: 'c2' }] }, '1'],
        ])
      )
    })
    const page = await withFetch(f, () =>
      contactCardPage({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        limit: 500,
        position: 1000,
        properties: ['id', 'name'],
      })
    )
    // The query's order, a card gone between the calls dropped, and every
    // returned id counted.
    expect(page).toEqual({ cards: [{ id: 'c2' }, { id: 'c1' }] as never, returned: 3, total: 1203 })
  })

  test('omits position 0 and a total the server did not count', async () => {
    const f = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][1]).toEqual({ accountId: 'acct', calculateTotal: true, limit: 10 })
      return Promise.resolve(
        jmapResponse([
          ['ContactCard/query', { ids: [] }, '0'],
          ['ContactCard/get', { list: [] }, '1'],
        ])
      )
    })
    const page = await withFetch(f, () =>
      contactCardPage({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        limit: 10,
        position: 0,
        properties: ['id'],
      })
    )
    expect(page).toEqual({ cards: [], returned: 0 })
  })
})

describe('contactCardQuery', () => {
  test('passes filter and limit through and returns the ids', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('ContactCard/query')
      expect(args).toEqual({
        accountId: 'acct',
        calculateTotal: false,
        filter: { conditions: [{ text: 'robin' }, { email: 'robin' }], operator: 'OR' },
        limit: 10,
      })
      return Promise.resolve(jmapResponse([['ContactCard/query', { ids: ['c1', 'c2'] }, '0']]))
    })
    const ids = await withFetch(f, () =>
      contactCardQuery({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        filter: { conditions: [{ text: 'robin' }, { email: 'robin' }], operator: 'OR' },
        limit: 10,
      })
    )
    expect(ids).toEqual(['c1', 'c2'])
  })

  test('omits filter and limit when unset and returns [] for an empty result', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls[0][1]).toEqual({ accountId: 'acct', calculateTotal: false })
      return Promise.resolve(jmapResponse([['ContactCard/query', {}, '0']]))
    })
    const ids = await withFetch(f, () =>
      contactCardQuery({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok' })
    )
    expect(ids).toEqual([])
  })
})

describe('contactCardCreate', () => {
  test('creates the card and returns the server-assigned id', async () => {
    const card = {
      addressBookIds: { ab1: true },
      emails: { e0: { address: 'robin@northwind.example' } },
      name: { full: 'Robin' },
      version: '1.0',
    }
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('ContactCard/set')
      expect(args.create.c0).toEqual(card)
      return Promise.resolve(jmapResponse([['ContactCard/set', { created: { c0: { id: 'c7' } } }, '0']]))
    })
    const id = await withFetch(f, () =>
      contactCardCreate({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', card })
    )
    expect(id).toBe('c7')
  })

  test('throws a JmapError naming the notCreated type', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['ContactCard/set', { notCreated: { c0: { type: 'invalidProperties' } } }, '0']]))
    )
    await withFetch(f, async () => {
      const err = await contactCardCreate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        card: { addressBookIds: { ab1: true } },
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).message).toContain('invalidProperties')
    })
  })
  // Stalwart 1.0 (assert_is_unique_uid): a uid already held in the target
  // address book is invalidProperties on `uid`, not a type of its own.
  test('throws ContactUidTakenError when the uid is already held in the book', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          [
            'ContactCard/set',
            {
              notCreated: {
                c0: {
                  description: 'Contact with UID x already exists with id b.',
                  properties: ['uid'],
                  type: 'invalidProperties',
                },
              },
            },
            '0',
          ],
        ])
      )
    )
    await withFetch(f, async () => {
      const err = await contactCardCreate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        card: { addressBookIds: { ab1: true }, uid: 'x' },
      }).catch((error) => error)
      expect(err).toBeInstanceOf(ContactUidTakenError)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).message).not.toContain('already exists')
    })
  })

  test('keeps a plain JmapError for invalidProperties on other properties', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          ['ContactCard/set', { notCreated: { c0: { properties: ['emails'], type: 'invalidProperties' } } }, '0'],
        ])
      )
    )
    await withFetch(f, async () => {
      const err = await contactCardCreate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        card: { addressBookIds: { ab1: true } },
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect(err).not.toBeInstanceOf(ContactUidTakenError)
    })
  })
})

describe('contactCardUpdate', () => {
  test('sends the patch under the card id', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('ContactCard/set')
      expect(args.update.c7).toEqual({ 'notes/collected': { 'langmail.me:collected': { grade: 'strong' }, note: '' } })
      return Promise.resolve(jmapResponse([['ContactCard/set', { updated: { c7: null } }, '0']]))
    })
    await withFetch(f, () =>
      contactCardUpdate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        cardId: 'c7',
        patch: { 'notes/collected': { 'langmail.me:collected': { grade: 'strong' }, note: '' } },
      })
    )
    expect(f).toHaveBeenCalled()
  })

  test('throws a JmapError naming the notUpdated type', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['ContactCard/set', { notUpdated: { c7: { type: 'notFound' } } }, '0']]))
    )
    await withFetch(f, async () => {
      const err = await contactCardUpdate({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        cardId: 'c7',
        patch: { name: { full: 'Robin' } },
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).message).toContain('notFound')
    })
  })
})

describe('contactCardDestroy', () => {
  test('sends ContactCard/set destroy with the single card id', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('ContactCard/set')
      expect(args).toEqual({ accountId: 'acct', destroy: ['c7'] })
      return Promise.resolve(jmapResponse([['ContactCard/set', { destroyed: ['c7'] }, '0']]))
    })
    await withFetch(f, () =>
      contactCardDestroy({ accountId: 'acct', apiUrl: API, authorization: 'Bearer tok', cardId: 'c7' })
    )
    expect(f).toHaveBeenCalled()
  })

  test('throws a JmapError naming the notDestroyed type', async () => {
    const f = mock(() =>
      Promise.resolve(jmapResponse([['ContactCard/set', { notDestroyed: { c7: { type: 'notFound' } } }, '0']]))
    )
    await withFetch(f, async () => {
      const err = await contactCardDestroy({
        accountId: 'acct',
        apiUrl: API,
        authorization: 'Bearer tok',
        cardId: 'c7',
      }).catch((error) => error)
      expect(err).toBeInstanceOf(JmapError)
      expect((err as JmapError).message).toContain('notFound')
    })
  })
})

describe('contactCardMerge', () => {
  const params = {
    accountId: 'acct',
    apiUrl: API,
    authorization: 'Bearer tok',
    cardId: 'keep',
    destroy: ['m1', 'm2'],
    patch: { 'emails/e1': { address: 'b@example.com' } },
  }

  test('sends the update and the destroys in one ContactCard/set', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.methodCalls).toHaveLength(1)
      const [name, args] = body.methodCalls[0]
      expect(name).toBe('ContactCard/set')
      expect(args).toEqual({
        accountId: 'acct',
        destroy: ['m1', 'm2'],
        update: { keep: { 'emails/e1': { address: 'b@example.com' } } },
      })
      return Promise.resolve(
        jmapResponse([['ContactCard/set', { destroyed: ['m1', 'm2'], updated: { keep: null } }, '0']])
      )
    })
    const result = await withFetch(f, () => contactCardMerge(params))
    expect(result).toEqual({ destroyed: ['m1', 'm2'], notDestroyed: {} })
  })

  test('reports a refused update and a refused destroy separately', async () => {
    const f = mock(() =>
      Promise.resolve(
        jmapResponse([
          [
            'ContactCard/set',
            {
              destroyed: ['m1'],
              notDestroyed: { m2: { type: 'forbidden' } },
              notUpdated: { keep: { type: 'invalidProperties' } },
            },
            '0',
          ],
        ])
      )
    )
    const result = await withFetch(f, () => contactCardMerge(params))
    expect(result).toEqual({ destroyed: ['m1'], notDestroyed: { m2: 'forbidden' }, updateError: 'invalidProperties' })
  })
})
