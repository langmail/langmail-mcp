// E2E for search_contacts against a REAL Stalwart: the collection pipeline
// (observation extraction → fold → ContactCard/set over JMAP for Contacts)
// seeds the collected address book exactly as the email-agent hook and the
// calendar write-through do, and the tool is then driven through live JMAP +
// CalDAV deps — proving Stalwart answers AddressBook/ContactCard
// methods with no extra configuration (the plan's infra check) and that the
// stored record ids hydrate back into human-readable interaction lines.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password — the deps pin
// the Basic credential while everything downstream is the live path.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test search-contacts-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { type CalDavConfig, discoverAccount, fetchEvents, putEvent } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import {
  COLLECTED_BOOK_NAME,
  collectContacts,
  liveCollectionDeps,
  observationsFromEmail,
  observationsFromEvent,
  readCollected,
  toCardAddress,
  toCardPhone,
} from '../contacts/index.ts'
import { parseEvents } from '../ical/index.ts'
import {
  addressBookList,
  contactCardCreate,
  contactCardGet,
  contactCardPage,
  contactCardQuery,
  emailGet,
  emailHeadersMatching,
  mailboxIdByRole,
  makeJmapLive,
} from '../jmap/index.ts'
import { untilIndexed } from '../search-index-test-wait.ts'
import { type SearchContactsDeps, searchContacts, searchContactsInput } from './search-contacts.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)

const DAY_MS = 86_400_000
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

const live = ADMIN_URL ? describe : describe.skip

const COLLECTION_HREF = /<D:href>([^<]+\/)<\/D:href>/giu
const CARD_HREF = /<D:href>([^<]+[^/])<\/D:href>/giu
const ROLE_LINE = /^ROLE[;:].*lawyer\r?$/mu

// Minimal admin JMAP call (x:-prefixed management methods; see
// services/auth/src/stalwart/admin-client.ts for the full contract).
const adminCall = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await fetch(`${ADMIN_URL}/jmap/`, {
    body: JSON.stringify({
      methodCalls: [[method, args, '0']],
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    }),
    headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
    method: 'POST',
  })
  if (res.status !== 200) {
    throw new Error(`${method} returned HTTP ${res.status}`)
  }
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] }
  const [name, payload] = body.methodResponses?.[0] ?? []
  if (name === 'error' || !payload) {
    throw new Error(`${method} failed: ${JSON.stringify(body)}`)
  }
  return payload
}

live('search_contacts against live Stalwart — collect from mail + calendar, then resolve', () => {
  const run = Date.now()
  const localPart = `mcp-contacts-e2e-${run}`
  const eventUid = `evt-lunch-${run}@langmail.me`
  const receivedAt = new Date(run - 4 * DAY_MS).toISOString()
  const eventStart = new Date(run + 3 * DAY_MS).toISOString()
  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let uploadUrl: string
  let inboxId: string
  let emailId: string
  let calendarUrl: string
  let caldavCfg: CalDavConfig
  let ctx: { accountId: string; apiUrl: string; authorization: string }
  let searchDeps: SearchContactsDeps
  let selfAddresses: Set<string>

  const importEmail = async (raw: string, mailboxId?: string): Promise<string> => {
    const uploadRes = await fetch(uploadUrl.replace('{accountId}', accountId).replace('{type}', 'message/rfc822'), {
      body: raw,
      headers: { authorization, 'content-type': 'message/rfc822' },
      method: 'POST',
    })
    expect(uploadRes.status).toBe(200)
    const { blobId } = (await uploadRes.json()) as { blobId: string }
    const importRes = await fetch(apiUrl, {
      body: JSON.stringify({
        methodCalls: [
          [
            'Email/import',
            { accountId, emails: { i0: { blobId, mailboxIds: { [mailboxId ?? inboxId]: true }, receivedAt } } },
            '0',
          ],
        ],
        using: USING,
      }),
      headers: { authorization, 'content-type': 'application/json' },
      method: 'POST',
    })
    const json = (await importRes.json()) as {
      methodResponses: [string, { created?: Record<string, { id: string }> }, string][]
    }
    const created = json.methodResponses[0]?.[1]?.created?.i0
    if (!created) {
      throw new Error(`Email/import failed: ${JSON.stringify(json)}`)
    }
    return created.id
  }

  // The same collection call the email-agent hook makes for a poll batch.
  const collectFromRobinEmail = () =>
    collectContacts(
      liveCollectionDeps,
      ctx,
      observationsFromEmail(
        {
          cc: [{ email: 'messaging-digest-noreply@linkedin.com', name: 'LinkedIn' }],
          from: [{ email: 'Robin@northwind.example', name: 'Robin Fairweather' }],
          id: emailId,
          receivedAt,
          to: [{ email: address }],
        },
        { selfAddresses }
      )
    )

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run services/auth's stalwart:setup first`)
    }
    const created = await adminCall('x:Account/set', {
      create: { a1: { '@type': 'User', domainId, name: localPart, roles: { '@type': 'User' } } },
    })
    const account = (created.created as { a1?: { id?: string } } | undefined)?.a1
    if (!account?.id) {
      throw new Error(`account not created: ${JSON.stringify(created)}`)
    }
    const minted = await adminCall('x:AppPassword/set', {
      accountId: account.id,
      create: { ap1: { allowedIps: {}, description: 'mcp contacts e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`
    selfAddresses = new Set([address])

    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string; uploadUrl: string }
    apiUrl = session.apiUrl
    uploadUrl = session.uploadUrl
    accountId = await makeJmapLive(ADMIN_URL as string).resolveAccountId(authorization)
    ctx = { accountId, apiUrl, authorization }

    // Mailbox for the seeded message (Stalwart auto-provisions the Inbox).
    const inboxRes = await fetch(apiUrl, {
      body: JSON.stringify({
        methodCalls: [['Mailbox/query', { accountId, filter: { role: 'inbox' } }, '0']],
        using: USING,
      }),
      headers: { authorization, 'content-type': 'application/json' },
      method: 'POST',
    })
    const inboxJson = (await inboxRes.json()) as { methodResponses: [string, { ids?: string[] }, string][] }
    const found = inboxJson.methodResponses[0]?.[1]?.ids?.[0]
    if (!found) {
      throw new Error('no inbox mailbox on the throwaway account')
    }
    inboxId = found

    // Seed 1 — mail: a direct message from Robin with a relay CC'd, imported
    // for real so subject hydration reads it back over Email/get.
    emailId = await importEmail(
      [
        'From: Robin Fairweather <robin@northwind.example>',
        `To: ${address}`,
        'Cc: LinkedIn <messaging-digest-noreply@linkedin.com>',
        'Subject: Northwind onboarding',
        `Message-ID: <1-${run}@mcp-contacts-e2e>`,
        'Date: Tue, 21 Jul 2026 10:00:00 +0000',
        '',
        'Welcome aboard!',
      ].join('\r\n')
    )
    await collectFromRobinEmail()

    // Seed 2 — calendar: a real event PUT to the default calendar (silent —
    // no iMIP fan-out from CI), then the same write-through fold the
    // calendar tools run after a successful scheduling action.
    caldavCfg = { authHeaders: () => ({ authorization }), serverUrl: ADMIN_URL as string }
    const discovered = await discoverAccount(caldavCfg, TOKEN)
    if (!discovered.defaultCalendarUrl) {
      throw new Error('no default calendar on the throwaway account')
    }
    calendarUrl = discovered.defaultCalendarUrl
    const ical = buildInvite({
      attendees: ['robin@northwind.example'],
      end: new Date(new Date(eventStart).getTime() + 60 * 60 * 1000),
      organizer: address,
      scheduleAgent: 'NONE',
      start: new Date(eventStart),
      title: 'Lunch — Kai & Robin',
      uid: eventUid,
    })
    await putEvent(caldavCfg, { calendarUrl, ical, token: TOKEN })
    await collectContacts(
      liveCollectionDeps,
      ctx,
      observationsFromEvent(
        {
          attendees: [{ email: 'robin@northwind.example' }],
          organizer: address,
          start: eventStart,
          uid: eventUid,
        },
        { kind: 'action', selfAddresses }
      )
    )

    searchDeps = {
      addressBookList: (p) => addressBookList({ ...p, apiUrl, authorization }),
      contactCardGet: (p) => contactCardGet({ ...p, apiUrl, authorization }),
      contactCardPage: (p) => contactCardPage({ ...p, apiUrl, authorization }),
      emailGet: (p) => emailGet({ ...p, apiUrl, authorization }),
      emailHeadersMatching: (p) => emailHeadersMatching({ ...p, apiUrl, authorization }),
      fetchEventTitles: async (_token, uids) => {
        const wanted = new Set(uids)
        const titles = new Map<string, string>()
        for (const object of await fetchEvents(caldavCfg, { calendarUrl, token: TOKEN })) {
          for (const event of parseEvents(object.data)) {
            if (wanted.has(event.uid) && event.title) {
              titles.set(event.uid, event.title)
            }
          }
        }
        return titles
      },
      resolveAccountId: () => Promise.resolve(accountId),
      resolveMailAccountId: () => Promise.resolve(accountId),
    }
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its mail, calendar, and
    // contact data. Always query by name (never gate on late-assigned state)
    // so a beforeAll that failed after account creation still cleans up.
    const query = await adminCall('x:Account/query', { filter: { name: localPart } })
    const ids = (query.ids as string[] | undefined) ?? []
    if (ids.length > 0) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('collection provisioned the Collected book and exactly one card for Robin', async () => {
    const books = await addressBookList(ctx)
    expect(books.map((b) => b.name)).toContain(COLLECTED_BOOK_NAME)
    const ids = await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: 'robin@northwind.example' } }),
      (found) => found.length > 0,
      'the collected card by email'
    )
    expect(ids).toHaveLength(1)
    const [card] = await contactCardGet({ ...ctx, ids })
    expect(card?.name?.full).toBe('Robin Fairweather')
    const ext = readCollected(card as NonNullable<typeof card>)
    // Mail sighting (strong) upgraded to confirmed by the scheduling action.
    expect(ext.addresses['robin@northwind.example']?.confidence).toBe('confirmed')
    expect(ext.addresses['robin@northwind.example']?.count).toBe(2)
    expect(ext.relays).toEqual(['messaging-digest-noreply@linkedin.com'])
  })

  test('a pre-existing card WITHOUT notes still accumulates collection data in place', async () => {
    // The personal-book case: a user-created card has no notes property, so
    // the fold must emit a full top-level notes set (RFC 8620 rejects a
    // scoped patch path whose parent is missing).
    const books = await addressBookList(ctx)
    const bookId = books.find((b) => b.isDefault)?.id ?? books[0]?.id
    if (!bookId) {
      throw new Error('no address book on the throwaway account')
    }
    const cardId = await contactCardCreate({
      ...ctx,
      card: {
        addressBookIds: { [bookId]: true },
        emails: { e0: { address: 'plain@example.com' } },
        name: { full: 'Plain Person' },
        uid: `plain-${run}`,
        version: '1.0',
      },
    })
    await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: 'plain@example.com' } }),
      (found) => found.includes(cardId),
      'the personal-book card by email'
    )
    await collectContacts(
      liveCollectionDeps,
      ctx,
      observationsFromEmail(
        {
          from: [{ email: 'plain@example.com', name: 'Plain Person' }],
          id: `m-plain-${run}`,
          receivedAt,
          to: [{ email: address }],
        },
        { selfAddresses }
      )
    )
    const [card] = await contactCardGet({ ...ctx, ids: [cardId] })
    const ext = readCollected(card as NonNullable<typeof card>)
    expect(ext.addresses['plain@example.com']?.count).toBe(1)
    // No duplicate was created for the address.
    const ids = await contactCardQuery({ ...ctx, filter: { email: 'plain@example.com' } })
    expect(ids).toEqual([cardId])
  })

  test('re-collecting the same mail batch never double-counts or duplicates', async () => {
    await collectFromRobinEmail()
    const ids = await contactCardQuery({ ...ctx, filter: { email: 'robin@northwind.example' } })
    expect(ids).toHaveLength(1)
    const [card] = await contactCardGet({ ...ctx, ids })
    const ext = readCollected(card as NonNullable<typeof card>)
    expect(ext.addresses['robin@northwind.example']?.count).toBe(2)
  })

  test('concise: resolves "Robin" to the confirmed work address with hydrated interactions', async () => {
    const result = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'robin' }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('1 person(s) matched')
    expect(text).toContain('Robin Fairweather')
    expect(text).toContain('best_address: robin@northwind.example (work)')
    expect(text).toContain('address_confidence: confirmed')
    expect(text).toContain('calendar: Lunch — Kai & Robin')
    expect(text).toContain('email received: Northwind onboarding')
    expect(text).toContain('relay addresses')
  })

  test('detailed: adds record ids for chaining and the excluded relay', async () => {
    const result = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'northwind', response_format: 'detailed' }),
      token: TOKEN,
    })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain(`[event uid: ${eventUid}]`)
    expect(text).toContain(`[email id: ${emailId}]`)
    expect(text).toContain('excluded_relays: messaging-digest-noreply@linkedin.com')
  })

  test('a personal card duplicating a Collected one absorbs it on the next sighting', async () => {
    const sam = 'sam.twin@example.com'
    const fromSam = (id: string) =>
      collectContacts(
        liveCollectionDeps,
        ctx,
        observationsFromEmail(
          { from: [{ email: sam, name: 'Sam Twin' }], id, receivedAt, to: [{ email: address }] },
          { selfAddresses }
        )
      )
    await fromSam(`m-sam-1-${run}`)
    const [collectedId] = await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: sam } }),
      (found) => found.length === 1,
      'the Collected card for Sam'
    )
    // The import: a personal-book card for the same address, with a phone.
    const books = await addressBookList(ctx)
    const bookId = books.find((b) => b.name !== COLLECTED_BOOK_NAME)?.id
    if (!bookId) {
      throw new Error('no personal address book on the throwaway account')
    }
    const personalId = await contactCardCreate({
      ...ctx,
      card: {
        addressBookIds: { [bookId]: true },
        emails: { e0: { address: sam } },
        name: { full: 'Sam Twin' },
        phones: { p0: toCardPhone({ label: 'mobile', number: '+49 151 9876543' }) },
        uid: `sam-twin-${run}`,
        version: '1.0',
      },
    })
    await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: sam } }),
      (found) => found.includes(personalId) && found.length === 2,
      'both cards for Sam'
    )

    await fromSam(`m-sam-2-${run}`)

    expect(await contactCardGet({ ...ctx, ids: [collectedId as string] })).toEqual([])
    const [personal] = await contactCardGet({ ...ctx, ids: [personalId] })
    expect(readCollected(personal as NonNullable<typeof personal>).addresses[sam]?.count).toBe(2)
    await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: sam } }),
      (found) => found.length === 1 && found[0] === personalId,
      'the Collected card dropping out of the index'
    )
    const result = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'Twin', response_format: 'detailed' }),
      token: TOKEN,
    })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('1 person(s) matched')
    expect(text).toContain('+49 151 9876543')
    expect(text).toContain(`[email id: m-sam-1-${run}]`)
    // Three index waits of up to 3 s each, beyond bun's default 5 s.
  }, 15_000)

  test('an unknown name gets the instructive empty result', async () => {
    const result = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: `zz-nobody-${run}` }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('No contact matched')
  })

  test('self-hosted: a person with no card is found in the mail headers, marked as not saved', async () => {
    for (const n of [1, 2]) {
      await importEmail(
        [
          'From: Quinn Larkspur <quinn@larkspur-law.example>',
          `To: ${address}`,
          'Cc: Office <office@larkspur-law.example>',
          `Subject: Your case, part ${n}`,
          `Message-ID: <quinn-${n}-${run}@mcp-contacts-e2e>`,
          'Date: Tue, 21 Jul 2026 10:00:00 +0000',
          '',
          'Please find the documents attached.',
        ].join('\r\n')
      )
    }
    // The same name from a spammer, in Junk: not a person the user wrote with.
    const junkId = await mailboxIdByRole({ ...ctx, role: 'junk' })
    expect(junkId).not.toBeNull()
    await importEmail(
      [
        'From: Quinn Larkspur <quinn@spam-larkspur.example>',
        `To: ${address}`,
        'Subject: You won',
        `Message-ID: <quinn-spam-${run}@mcp-contacts-e2e>`,
        'Date: Tue, 21 Jul 2026 10:00:00 +0000',
        '',
        'Claim your prize.',
      ].join('\r\n'),
      junkId ?? undefined
    )
    // The header index catches up shortly after an import.
    let text = ''
    for (let attempt = 0; attempt < 10 && !text.includes('quinn@larkspur-law.example'); attempt += 1) {
      await Bun.sleep(300)
      const result = await searchContacts(searchDeps, {
        args: searchContactsInput.parse({ query: 'Quinn Larkspur' }),
        mode: 'self-hosted',
        token: TOKEN,
      })
      text = result.content[0]?.text ?? ''
    }
    expect(text).toContain('No contact matched "Quinn Larkspur" in any address book')
    expect(text).toContain('1 person(s) found in the From, To and Cc')
    expect(text).toContain('address: quinn@larkspur-law.example')
    expect(text).toContain('(2 messages)')
    expect(text).not.toContain('office@larkspur-law.example')
    expect(text).not.toContain('spam-larkspur')
  }, 15_000)

  // Last, because it fills the book with 300 cards. Stalwart's query cannot
  // match a role (docs/upstream/stalwart/contact-query-cannot-match-titles.md),
  // so the whole-book sweep is the only read that reaches the role card.
  test('cards past position 300 are found: one with no email by name, one by its role alone', async () => {
    const [book] = (await addressBookList(ctx)).filter((b) => b.name !== COLLECTED_BOOK_NAME)
    const bookId = (book as NonNullable<typeof book>).id
    const create: Record<string, unknown> = {}
    for (let i = 0; i < 300; i += 1) {
      create[`f${i}`] = {
        addressBookIds: { [bookId]: true },
        emails: { e0: { address: `filler-${i}@example.org` } },
        name: { full: `Filler ${i}` },
      }
    }
    const res = await fetch(apiUrl, {
      body: JSON.stringify({
        methodCalls: [['ContactCard/set', { accountId, create }, '0']],
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
      }),
      headers: { authorization, 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const lawyerId = await contactCardCreate({
      ...ctx,
      card: {
        addressBookIds: { [bookId]: true },
        emails: { e0: { address: 'robin@fairweather-law.example' } },
        name: { full: 'Robin Lawyer-Card' },
        titles: { r0: { kind: 'role', name: 'lawyer' } },
        uid: `role-card-${run}`,
      },
    })
    // What create_contact writes from a name and a postal address.
    const henrikeId = await contactCardCreate({
      ...ctx,
      card: {
        addressBookIds: { [bookId]: true },
        addresses: { a0: toCardAddress({ city: 'Berlin', label: 'home', street: 'Beispielweg 1' }) },
        name: { full: 'Henrike Wolters' },
        uid: `no-email-${run}`,
      },
    })

    // The upstream gap itself: once the index has the card (found by name),
    // a word that is only in its title is still not found. When this turns
    // red, Stalwart searches titles and that upstream entry closes
    // (docs/upstream/stalwart/contact-query-cannot-match-titles.md).
    const titleWord = `zzrole${run}`
    const titleOnlyId = await contactCardCreate({
      ...ctx,
      card: {
        addressBookIds: { [bookId]: true },
        name: { full: `Title Probe ${run}` },
        titles: { r0: { kind: 'role', name: titleWord } },
      },
    })
    await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { text: `Probe ${run}` } }),
      (found) => found.includes(titleOnlyId),
      'the title probe card reaching the index'
    )
    expect(await contactCardQuery({ ...ctx, filter: { text: titleWord } })).toEqual([])

    // Both cards really are past position 300 of the unfiltered order.
    const order = await contactCardQuery({ ...ctx, limit: 1000 })
    expect(order.indexOf(lawyerId)).toBeGreaterThan(300)
    expect(order.indexOf(henrikeId)).toBeGreaterThan(300)
    // The sweep's narrow page: one request, only the asked-for properties.
    const page = await contactCardPage({ ...ctx, limit: 500, position: 0, properties: ['id', 'name', 'titles'] })
    expect(page.total).toBe(order.length)
    const narrow = page.cards.find((c) => c.id === lawyerId)
    expect(narrow?.titles).toEqual({ r0: { kind: 'role', name: 'lawyer' } })
    expect(narrow?.emails).toBeUndefined()

    const byRole = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'my lawyer' }),
      token: TOKEN,
    })
    const text = byRole.content[0]?.text ?? ''
    expect(text).toContain('1. Robin Lawyer-Card')
    expect(text).toContain('roles: lawyer')

    const byName = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'Wolters' }),
      token: TOKEN,
    })
    expect(byName.content[0]?.text).toContain('1 person(s) matched')
    expect(byName.content[0]?.text).toContain(`contact_id: ${henrikeId}`)

    // Over CardDAV the role is an ordinary vCard field, not a group.
    const home = `${ADMIN_URL}/dav/card/${encodeURIComponent(address)}/`
    const listing = await (await fetch(home, { headers: { authorization, depth: '1' }, method: 'PROPFIND' })).text()
    const books = [...listing.matchAll(COLLECTION_HREF)].map((m) => m[1]).filter((h) => h !== new URL(home).pathname)
    const vcards: string[] = []
    for (const href of books) {
      const inBook = await (
        await fetch(`${ADMIN_URL}${href}`, { headers: { authorization, depth: '1' }, method: 'PROPFIND' })
      ).text()
      for (const [, card] of inBook.matchAll(CARD_HREF)) {
        const body = await (await fetch(`${ADMIN_URL}${card}`, { headers: { authorization } })).text()
        if (body.includes('Robin Lawyer-Card')) {
          vcards.push(body)
        }
      }
    }
    expect(vcards).toHaveLength(1)
    expect(vcards[0]).toMatch(ROLE_LINE)
    expect(vcards[0]).not.toContain('CATEGORIES')
  }, 30_000)
})
