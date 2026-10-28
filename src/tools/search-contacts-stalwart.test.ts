// E2E for search_contacts against a REAL Stalwart: the collection pipeline
// (observation extraction → fold → ContactCard/set over JMAP for Contacts)
// seeds the collected address book exactly as the email-agent hook and the
// calendar write-through do, and the tool is then driven through live JMAP +
// CalDAV deps — proving Stalwart 0.16.x answers AddressBook/ContactCard
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

import {
  COLLECTED_BOOK_NAME,
  collectContacts,
  liveCollectionDeps,
  observationsFromEmail,
  observationsFromEvent,
  readCollected,
} from '@langmail/contacts'
import { parseEvents } from '@langmail/ical'
import {
  addressBookList,
  contactCardCreate,
  contactCardGet,
  contactCardQuery,
  emailGet,
  makeJmapLive,
} from '@langmail/jmap'

import { type CalDavConfig, discoverAccount, fetchEvents, putEvent } from '../caldav/client.ts'
import { buildInvite } from '../caldav/ical.ts'
import { type SearchContactsDeps, searchContacts, searchContactsInput } from './search-contacts.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)

const DAY_MS = 86_400_000
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

const live = ADMIN_URL ? describe : describe.skip

// Minimal admin JMAP call (x:-prefixed management methods; see
// services/auth/src/stalwart/admin-client.ts for the full contract).
// Stalwart 1.0 indexes for search asynchronously: a card turns up in an
// `email` or text query a moment after it is written. The merge into a
// personal-book card reads through that index, so the steps that depend on an
// earlier write wait for it rather than race it.
const untilIndexed = async <T>(read: () => Promise<T>, settled: (value: T) => boolean): Promise<T> => {
  for (let i = 0; i < 50; i += 1) {
    const value = await read()
    if (settled(value)) {
      return value
    }
    await Bun.sleep(100)
  }
  return read()
}

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

  const importEmail = async (raw: string): Promise<string> => {
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
          ['Email/import', { accountId, emails: { i0: { blobId, mailboxIds: { [inboxId]: true }, receivedAt } } }, '0'],
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
      contactCardGet: (p) => contactCardGet({ ...p, apiUrl, authorization }),
      contactCardQuery: (p) => contactCardQuery({ ...p, apiUrl, authorization }),
      emailGet: (p) => emailGet({ ...p, apiUrl, authorization }),
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
      (found) => found.length > 0
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
      (found) => found.includes(cardId)
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

  test('an unknown name gets the instructive empty result', async () => {
    const result = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: `zz-nobody-${run}` }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('No contact matched')
  })
})
