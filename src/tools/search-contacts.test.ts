import { describe, expect, test } from 'bun:test'

import { COLLECTED_NOTE_KEY, collectedNoteEntry } from '@langmail/contacts'
import { type ContactCard } from '@langmail/jmap'

import { type SearchContactsDeps, searchContacts, searchContactsInput } from './search-contacts.ts'

const DAY_MS = 86_400_000
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString()

const robinCard = (over: Partial<ContactCard> = {}): ContactCard =>
  ({
    addressBookIds: { collected: true },
    emails: {
      e0: { address: 'robin@northwind.example', contexts: { work: true } },
      e1: { address: 'robin.private@gmail.com', contexts: { private: true } },
    },
    id: 'card-robin',
    name: { full: 'Robin Fairweather' },
    notes: {
      [COLLECTED_NOTE_KEY]: collectedNoteEntry({
        addresses: {
          'robin.private@gmail.com': { confidence: 'weak', count: 1, firstSeen: daysAgo(200), lastSeen: daysAgo(200) },
          'robin@northwind.example': {
            confidence: 'confirmed',
            count: 4,
            firstSeen: daysAgo(90),
            lastSeen: daysAgo(4),
          },
        },
        interactions: [
          { channel: 'calendar', date: daysAgo(4), direction: 'outgoing', recordId: 'evt-lunch@langmail.me' },
          { channel: 'email', date: daysAgo(24), direction: 'incoming', recordId: 'mail-1' },
          { channel: 'email', date: daysAgo(49), direction: 'outgoing', recordId: 'mail-2' },
        ],
        relays: ['messaging-digest-noreply@linkedin.com'],
      }),
    },
    ...over,
  }) as ContactCard

const makeDeps = (cards: ContactCard[], over: Partial<SearchContactsDeps> = {}): SearchContactsDeps => ({
  contactCardGet: () => Promise.resolve(cards),
  contactCardQuery: () => Promise.resolve(cards.map((c) => c.id)),
  emailGet: (p) =>
    Promise.resolve(p.ids.map((id) => ({ id, subject: id === 'mail-1' ? 'Northwind onboarding' : 'Follow-up' }))),
  fetchEventTitles: (_token, uids) => Promise.resolve(new Map(uids.map((uid) => [uid, 'Lunch — Kai & Robin']))),
  resolveAccountId: () => Promise.resolve('acct'),
  resolveMailAccountId: () => Promise.resolve('acct'),
  ...over,
})

const args = (over: Record<string, unknown> = {}) => searchContactsInput.parse({ query: 'robin', ...over })

describe('searchContacts — concise', () => {
  test('the Robin case: confirmed work address, computed relationship, hydrated interactions', async () => {
    const result = await searchContacts(makeDeps([robinCard()]), { args: args(), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(text).toContain('Robin Fairweather')
    expect(text).toContain('best_address: robin@northwind.example (work)')
    expect(text).toContain('address_confidence: confirmed | relationship: active')
    expect(text).toContain('4 days ago — calendar: Lunch — Kai & Robin')
    expect(text).toContain('24 days ago — email received: Northwind onboarding')
    // Concise never exposes raw counts or record ids.
    expect(text).not.toContain('count')
    expect(text).not.toContain('evt-lunch@langmail.me')
    // But it does flag that a relay was excluded.
    expect(text).toContain('relay addresses')
  })

  test('a private context bias flips the best address without dropping the person', async () => {
    const result = await searchContacts(makeDeps([robinCard()]), { args: args({ context: 'private' }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('best_address: robin.private@gmail.com (private)')
    expect(text).toContain('address_confidence: weak')
  })

  test('empty result names the sources and steers the next attempt', async () => {
    const deps = makeDeps([], { contactCardQuery: () => Promise.resolve([]) })
    const result = await searchContacts(deps, { args: args({ query: 'nonexistent' }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('No contact matched "nonexistent"')
    expect(text).toContain('collected address book')
    expect(text).toContain('LinkedIn or another platform')
  })

  test('truncation names the total and invites a narrower query', async () => {
    const cards = Array.from({ length: 7 }, (_, i) =>
      robinCard({
        emails: { e0: { address: `robin${i}@corp${i}.example` } },
        id: `card-${i}`,
        name: { full: `Robin Number${i}` },
      })
    )
    const result = await searchContacts(makeDeps(cards), { args: args({ limit: 3 }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('3 person(s) matched')
    expect(text).toContain('Showing the top 3 of 7 matches')
  })

  test('same-name people stay separate entries, ranked by relationship then recency', async () => {
    const other = robinCard({
      emails: { e0: { address: 'robin@elsewhere.example' } },
      id: 'card-other',
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry({
          addresses: {
            'robin@elsewhere.example': {
              confidence: 'strong',
              count: 1,
              firstSeen: daysAgo(10),
              lastSeen: daysAgo(10),
            },
          },
          interactions: [{ channel: 'email', date: daysAgo(10), direction: 'incoming', recordId: 'mail-9' }],
        }),
      },
    })
    const result = await searchContacts(makeDeps([other, robinCard()]), { args: args(), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('2 person(s) matched')
    // The active Robin (card-robin) ranks above the incidental one.
    expect(text.indexOf('robin@northwind.example')).toBeLessThan(text.indexOf('robin@elsewhere.example'))
  })

  test('client-side refinement drops cards the query does not actually match', async () => {
    const unrelated = robinCard({
      emails: { e0: { address: 'someone@else.example' } },
      id: 'card-unrelated',
      name: { full: 'Someone Else' },
    })
    const result = await searchContacts(makeDeps([robinCard(), unrelated]), { args: args(), token: 'tok' })
    expect(result.content[0]?.text).toContain('1 person(s) matched')
  })

  test('a server hit on the shared collection note alone is not a match', async () => {
    // Every collected card carries the same machine-written note, so the
    // server's `text` condition returns the whole book for a word from it.
    // Refinement is authoritative: the answer must be the empty result.
    const result = await searchContacts(makeDeps([robinCard()]), {
      args: args({ query: 'Maintained' }),
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('No contact matched "Maintained"')
  })

  test('matches on an organization name and shows it', async () => {
    const withOrg = robinCard({ organizations: { o0: { name: 'Northwind' } } })
    const result = await searchContacts(makeDeps([withOrg]), { args: args({ query: 'northwind' }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('1 person(s) matched')
    expect(text).toContain('organization: Northwind')
  })

  test('hydration failures degrade lines instead of failing the search', async () => {
    const deps = makeDeps([robinCard()], {
      emailGet: () => Promise.reject(new Error('jmap down')),
      fetchEventTitles: () => Promise.reject(new Error('caldav down')),
    })
    const result = await searchContacts(deps, { args: args(), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(text).toContain('(event no longer available)')
    expect(text).toContain('(message no longer available)')
  })
})

describe('searchContacts — detailed', () => {
  test('adds every address, record ids for chaining, and excluded relays', async () => {
    const result = await searchContacts(makeDeps([robinCard()]), {
      args: args({ response_format: 'detailed' }),
      token: 'tok',
    })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('robin@northwind.example (work, confirmed')
    expect(text).toContain('robin.private@gmail.com (private, weak')
    expect(text).toContain('[event uid: evt-lunch@langmail.me]')
    expect(text).toContain('[email id: mail-1]')
    expect(text).toContain('excluded_relays: messaging-digest-noreply@linkedin.com')
  })
})

describe('searchContactsInput', () => {
  test('requires a query and bounds the limit', () => {
    expect(searchContactsInput.safeParse({}).success).toBe(false)
    expect(searchContactsInput.safeParse({ limit: 26, query: 'x' }).success).toBe(false)
    const parsed = searchContactsInput.parse({ query: 'robin' })
    expect(parsed.context).toBe('any')
    expect(parsed.limit).toBe(5)
    expect(parsed.response_format).toBe('concise')
  })
})
