import { describe, expect, test } from 'bun:test'

import {
  birthAnniversary,
  COLLECTED_BOOK_NAME,
  COLLECTED_NOTE_KEY,
  collectContacts,
  collectedNoteEntry,
  toCardAddress,
  toCardPhone,
  USER_NOTE_KEY,
} from '@langmail/contacts'
import { type ContactCard } from '@langmail/jmap'

import { fakeBook } from './contact-test-fixtures.ts'
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
  addressBookList: () => Promise.resolve([{ id: 'book-collected', name: COLLECTED_BOOK_NAME }]),
  // Honours `ids` — the tool unions two query results, so a seam that
  // returned every card regardless would hide which read found whom.
  contactCardGet: (p) => Promise.resolve(cards.filter((c) => p.ids.includes(c.id))),
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

  test('a preferred address comes first, unless a context asks for the other kind', async () => {
    const pinned = robinCard({
      emails: {
        e0: { address: 'robin@northwind.example', contexts: { work: true } },
        e1: { address: 'robin.private@gmail.com', contexts: { private: true }, pref: 1 },
      },
    })
    const any = (await searchContacts(makeDeps([pinned]), { args: args(), token: 'tok' })).content[0]?.text ?? ''
    expect(any).toContain('best_address: robin.private@gmail.com (private)')
    const work = await searchContacts(makeDeps([pinned]), { args: args({ context: 'work' }), token: 'tok' })
    expect(work.content[0]?.text).toContain('best_address: robin@northwind.example (work)')
    const detailed = await searchContacts(makeDeps([pinned]), {
      args: args({ response_format: 'detailed' }),
      token: 'tok',
    })
    expect(detailed.content[0]?.text).toContain('- robin.private@gmail.com (private, weak, preferred,')
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

  test('a personal card duplicating a Collected one is one entry after the next sighting', async () => {
    // The pair a contact import leaves: the personal card holds the details,
    // the Collected card the history. Collection merges them.
    const personal: ContactCard = {
      addressBookIds: { 'ab-personal': true },
      addresses: { a0: toCardAddress({ city: 'München', label: 'home', street: 'Beispielweg 1' }) },
      anniversaries: { b0: birthAnniversary({ day: 14, month: 3 }) },
      emails: { e0: { address: 'robin@northwind.example' } },
      id: 'card-personal',
      name: { full: 'Robin Fairweather' },
      phones: { p0: toCardPhone({ label: 'mobile', number: '+49 151 2345678' }) },
    }
    const collected = robinCard({ addressBookIds: { 'book-collected': true } })
    const book = fakeBook(
      [collected, personal],
      [
        { id: 'book-collected', name: COLLECTED_BOOK_NAME },
        { id: 'ab-personal', name: 'Contacts' },
      ]
    )
    await collectContacts(
      book.deps,
      { accountId: 'acct', apiUrl: '', authorization: 'Bearer tok' },
      {
        observations: [
          {
            address: 'robin@northwind.example',
            channel: 'email',
            confidence: 'strong',
            date: daysAgo(1),
            direction: 'incoming',
            name: 'Robin Fairweather',
            recordId: 'mail-3',
          },
        ],
        relays: [],
      }
    )
    expect([...book.cards.keys()]).toEqual(['card-personal'])

    const result = await searchContacts(makeDeps([...book.cards.values()]), {
      args: args({ response_format: 'detailed' }),
      token: 'tok',
    })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('1 person(s) matched')
    expect(text).toContain('+49 151 2345678')
    expect(text).toContain('Beispielweg 1')
    expect(text).toContain('birthday: --03-14')
    expect(text).toContain('source: imported')
    // The collected history, now on the personal card.
    expect(text).toContain('mail-1')
    expect(text).toContain('mail-3')
    expect(text).toContain('robin.private@gmail.com')
  })

  test('an old Collected card without a marker prints source: derived', async () => {
    // robinCard carries no source marker and no collected uid; only its book
    // says collection wrote it.
    const result = await searchContacts(makeDeps([robinCard({ addressBookIds: { 'book-collected': true } })]), {
      args: args({ response_format: 'detailed' }),
      token: 'tok',
    })
    expect(result.content[0]?.text).toContain('source: derived')
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

  test('finds a contact that has no email address at all, by name', async () => {
    // The shape create_contact can write: a name and a postal address,
    // nobody's mail header involved. Stalwart does not return such a card for
    // a server-side query on its display name, so the tool falls back to an
    // unfiltered read of the book — modelled here by a query seam that
    // answers the filtered call with nothing.
    const authored = robinCard({
      addresses: { a0: toCardAddress({ city: 'München', label: 'home', street: 'Beispielweg 1' }) },
      emails: {},
      id: 'card-authored',
    })
    const deps = makeDeps([authored], {
      contactCardQuery: (p) => Promise.resolve(p.filter === undefined ? ['card-authored'] : []),
    })
    const result = await searchContacts(deps, { args: args({ query: 'Fairweather' }), token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('1 person(s) matched')
    expect(result.content[0]?.text).toContain('contact_id: card-authored')
  })

  test('an emailless contact is not hidden by an addressed one matching the same query', async () => {
    // The filtered read finds only the addressed card; the sweep finds only
    // the emailless one. Choosing between them would drop a person, and this
    // tool is supposed to present ambiguity rather than resolve it silently.
    const addressed = robinCard()
    const authored = robinCard({ emails: {}, id: 'card-authored', name: { full: 'Robin Fairweather-Ng' } })
    const deps = makeDeps([addressed, authored], {
      contactCardQuery: (p) => Promise.resolve(p.filter === undefined ? ['card-authored'] : ['card-robin']),
    })
    const result = await searchContacts(deps, { args: args({ query: 'Fairweather' }), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('2 person(s) matched')
    expect(text).toContain('contact_id: card-robin')
    expect(text).toContain('contact_id: card-authored')
  })

  test('a genuinely unknown person is still the empty result after the fallback', async () => {
    const deps = makeDeps([], { contactCardQuery: () => Promise.resolve([]) })
    const result = await searchContacts(deps, { args: args({ query: 'nobody' }), token: 'tok' })
    expect(result.content[0]?.text).toContain('No contact matched')
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

  test('surfaces the authored half of the record with handles the write tools take', async () => {
    const card = robinCard({
      addresses: {
        a0: toCardAddress({
          city: 'München',
          country: 'DE',
          label: 'home',
          postalCode: '80331',
          street: 'Beispielweg 1',
        }),
      },
      notes: {
        [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'derived' }),
        [USER_NOTE_KEY]: { note: 'Prefers letters.' },
      },
      phones: { p0: toCardPhone({ label: 'mobile', number: '+49 89 1234567' }) },
    })
    const result = await searchContacts(makeDeps([card]), {
      args: args({ response_format: 'detailed' }),
      token: 'tok',
    })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('[p0] +49 89 1234567 (mobile)')
    expect(text).toContain('[a0] Beispielweg 1, 80331 München, DE (home)')
    expect(text).toContain('note: Prefers letters.')
    expect(text).toContain('source: derived')
  })

  test('the birthday shows once in the concise format and once in the detailed format', async () => {
    const card = robinCard({ anniversaries: { b: { date: { day: 3, month: 3, year: 1990 }, kind: 'birth' } } })
    const concise = await searchContacts(makeDeps([card]), { args: args(), token: 'tok' })
    const conciseText = concise.content[0]?.text ?? ''
    expect(conciseText.split('birthday: 1990-03-03')).toHaveLength(2)

    const detailed = await searchContacts(makeDeps([card]), {
      args: args({ response_format: 'detailed' }),
      token: 'tok',
    })
    const detailedText = detailed.content[0]?.text ?? ''
    expect(detailedText.split('birthday: 1990-03-03')).toHaveLength(2)
  })

  test('no birthday line when none is stored', async () => {
    const result = await searchContacts(makeDeps([robinCard()]), { args: args(), token: 'tok' })
    expect(result.content[0]?.text).not.toContain('birthday:')
  })

  test('the concise format keeps the postal address out of a name-resolution answer', async () => {
    const card = robinCard({ addresses: { a0: toCardAddress({ city: 'München', label: 'home' }) } })
    const result = await searchContacts(makeDeps([card]), { args: args(), token: 'tok' })
    const text = result.content[0]?.text ?? ''
    expect(text).not.toContain('postal_addresses')
    // The contact id is in both formats: editing must not cost a second call.
    expect(text).toContain('contact_id: card-robin')
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
