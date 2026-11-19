// E2E for the contact write tools against a REAL Stalwart. It walks the
// trace the feature was specified against: an agent is given a person's name
// and postal address in conversation and nothing else, creates a contact
// holding both, reads it back through search_contacts with the postal
// address present, corrects a single field without re-sending the rest, and
// deletes it — none of which touches the Langmail UI.
//
// The reason this has to run against a live server rather than a fake: the
// tools write JSContact properties (`addresses` with structured components,
// `phones`, a second note entry alongside the machine-owned one) that
// Stalwart has never been asked to round-trip before. A unit test proves the
// mapping; only this proves the server keeps it.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password — the deps pin
// the Basic credential while everything downstream is the live path.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `services/auth bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test contacts-write-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  collectContacts,
  collectedUid,
  liveCollectionDeps,
  observationsFromEmail,
  readBirthday,
  readCollected,
  readPostalAddresses,
  sourceOf,
} from '../contacts/index.ts'
import {
  addressBookCreate,
  addressBookList,
  contactCardCreate,
  contactCardDestroy,
  contactCardGet,
  contactCardMerge,
  contactCardPage,
  contactCardQuery,
  contactCardUpdate,
  emailGet,
  makeJmapLive,
} from '../jmap/index.ts'
import { untilIndexed } from '../search-index-test-wait.ts'
import { type ContactWriteDeps } from './contact-common.ts'
import { createContact, createContactInput } from './create-contact.ts'
import { deleteContact, deleteContactInput } from './delete-contact.ts'
import { listUpcomingBirthdays, listUpcomingBirthdaysInput } from './list-upcoming-birthdays.ts'
import { mergeContacts, mergeContactsInput } from './merge-contacts.ts'
import { type SearchContactsDeps, searchContacts, searchContactsInput } from './search-contacts.ts'
import { updateContact, updateContactInput } from './update-contact.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)

const live = ADMIN_URL ? describe : describe.skip

// The handle create_contact prints, which the other two tools address the
// record by — an agent reads it out of the prose exactly like this.
const CONTACT_ID = /contact_id: (\S+)/u

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

live('contact write tools against live Stalwart — author, read back, correct, delete', () => {
  const run = Date.now()
  const localPart = `mcp-contact-write-e2e-${run}`
  // Invented person; northwind.example is an RFC 2606 reserved domain.
  const PERSON = 'Robin Fairweather'
  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let ctx: { accountId: string; apiUrl: string; authorization: string }
  let writeDeps: ContactWriteDeps
  let searchDeps: SearchContactsDeps
  let contactId: string

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
      create: { ap1: { allowedIps: {}, description: 'mcp contact write e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`

    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string }
    apiUrl = session.apiUrl
    accountId = await makeJmapLive(ADMIN_URL as string).resolveAccountId(authorization)
    ctx = { accountId, apiUrl, authorization }

    const pin = <T extends { apiUrl: string; authorization: string }>(p: T): T => ({ ...p, apiUrl, authorization })
    writeDeps = {
      addressBookCreate: (p) => addressBookCreate(pin(p)),
      addressBookList: (p) => addressBookList(pin(p)),
      contactCardCreate: (p) => contactCardCreate(pin(p)),
      contactCardDestroy: (p) => contactCardDestroy(pin(p)),
      contactCardGet: (p) => contactCardGet(pin(p)),
      contactCardMerge: (p) => contactCardMerge(pin(p)),
      contactCardQuery: (p) => contactCardQuery(pin(p)),
      contactCardUpdate: (p) => contactCardUpdate(pin(p)),
      resolveAccountId: () => Promise.resolve(accountId),
    }
    searchDeps = {
      addressBookList: (p) => addressBookList(pin(p)),
      contactCardGet: (p) => contactCardGet(pin(p)),
      contactCardPage: (p) => contactCardPage(pin(p)),
      emailGet: (p) => emailGet(pin(p)),
      emailHeadersMatching: () => Promise.resolve([]),
      // No calendar seeding in this file — an authored contact has no
      // interactions to hydrate.
      fetchEventTitles: () => Promise.resolve(new Map()),
      resolveAccountId: () => Promise.resolve(accountId),
      resolveMailAccountId: () => Promise.resolve(accountId),
    }
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its address books.
    // Always query by name so a beforeAll that failed midway still cleans up.
    const query = await adminCall('x:Account/query', { filter: { name: localPart } })
    const ids = (query.ids as string[] | undefined) ?? []
    if (ids.length > 0) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('creates a contact from a name and a postal address alone — no email needed', async () => {
    const result = await createContact(writeDeps, {
      args: createContactInput.parse({
        name: PERSON,
        postalAddresses: [
          { city: 'München', country: 'DE', label: 'home', postalCode: '80333', street: 'Beispielweg 1' },
        ],
      }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    const id = CONTACT_ID.exec(result.content[0]?.text ?? '')?.[1]
    if (!id) {
      throw new Error(`no contact_id in create_contact output: ${result.content[0]?.text}`)
    }
    contactId = id

    // Stalwart kept the structured components rather than flattening them.
    const [card] = await contactCardGet({ ...ctx, ids: [contactId] })
    expect(readPostalAddresses(card as NonNullable<typeof card>)).toEqual([
      {
        city: 'München',
        country: 'DE',
        display: 'Beispielweg 1, 80333 München, DE',
        key: 'a0',
        label: 'home',
        postalCode: '80333',
        street: 'Beispielweg 1',
      },
    ])
    expect(sourceOf(card as NonNullable<typeof card>, undefined)).toBe('authored')
  })

  test('the contact landed in the default address book, so it syncs over CardDAV', async () => {
    const books = await addressBookList(ctx)
    const defaultBook = books.find((b) => b.isDefault)?.id
    const [card] = await contactCardGet({ ...ctx, ids: [contactId] })
    expect(Object.keys(card?.addressBookIds ?? {})).toEqual([defaultBook ?? (books[0]?.id as string)])
  })

  test('search_contacts reads it back with the postal address in the detailed response', async () => {
    const result = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'Fairweather', response_format: 'detailed' }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('1 person(s) matched')
    expect(text).toContain(PERSON)
    expect(text).toContain(`contact_id: ${contactId}`)
    expect(text).toContain('[a0] Beispielweg 1, 80333 München, DE (home)')
    expect(text).toContain('source: authored')
  })

  test('corrects a single component without re-sending the rest of the record', async () => {
    // First give the record more to lose, so the correction has something to
    // preserve: a phone, an address, an organization and a note.
    await updateContact(writeDeps, {
      args: updateContactInput.parse({
        addedEmails: [{ address: 'robin@northwind.example', context: 'work' }],
        addedPhones: [{ label: 'mobile', number: '+49 89 1234567' }],
        contactId,
        note: 'Prefers letters.',
        organization: 'Northwind',
      }),
      token: TOKEN,
    })

    // The correction: one wrong digit in the postal code, nothing else sent.
    const result = await updateContact(writeDeps, {
      args: updateContactInput.parse({ contactId, updatedPostalAddresses: [{ key: 'a0', postalCode: '80331' }] }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()

    const [card] = await contactCardGet({ ...ctx, ids: [contactId] })
    const stored = card as NonNullable<typeof card>
    expect(readPostalAddresses(stored)).toEqual([
      {
        city: 'München',
        country: 'DE',
        display: 'Beispielweg 1, 80331 München, DE',
        key: 'a0',
        label: 'home',
        postalCode: '80331',
        street: 'Beispielweg 1',
      },
    ])
    // Everything the correction did not name survived it.
    expect(Object.values(stored.phones ?? {})[0]?.number).toBe('+49 89 1234567')
    expect(Object.values(stored.organizations ?? {})[0]?.name).toBe('Northwind')
    expect(Object.values(stored.emails ?? {})[0]?.address).toBe('robin@northwind.example')
    expect(result.content[0]?.text).toContain('note: Prefers letters.')
  })

  test('a later derivation adds to the authored card without relabelling or overwriting it', async () => {
    await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: 'robin@northwind.example' } }),
      (found) => found.includes(contactId),
      'the created contact by email'
    )
    // The same collection call the email-agent hook makes for a poll batch,
    // naming the person differently than the user typed.
    await collectContacts(
      liveCollectionDeps,
      ctx,
      observationsFromEmail(
        {
          from: [{ email: 'robin@northwind.example', name: 'R. Fairweather' }],
          id: `m-authored-${run}`,
          receivedAt: new Date(run - 86_400_000).toISOString(),
          to: [{ email: address }],
        },
        { selfAddresses: new Set([address]) }
      )
    )
    // No second card was minted for an address the authored one already holds.
    const ids = await contactCardQuery({ ...ctx, filter: { email: 'robin@northwind.example' } })
    expect(ids).toEqual([contactId])

    const [card] = await contactCardGet({ ...ctx, ids: [contactId] })
    const stored = card as NonNullable<typeof card>
    expect(stored.name?.full).toBe(PERSON)
    expect(sourceOf(stored, undefined)).toBe('authored')
    // And the authored fields the fold never touches are still there.
    expect(readPostalAddresses(stored)).toHaveLength(1)
  })

  test('creating the same person again is refused and points at the existing record', async () => {
    const result = await createContact(writeDeps, {
      args: createContactInput.parse({ emails: [{ address: 'Robin@Northwind.example' }], name: PERSON }),
      token: TOKEN,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(contactId)
  })

  test('a yearless birthday round-trips through Stalwart and shows up as upcoming', async () => {
    // `--MM-DD`: the partial date must come back without a year — a server
    // that filled one in would report a wrong age on every synced device.
    const result = await updateContact(writeDeps, {
      args: updateContactInput.parse({ birthday: '--03-03', contactId }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('birthday: --03-03')

    const [card] = await contactCardGet({ ...ctx, ids: [contactId] })
    expect(readBirthday(card as NonNullable<typeof card>)).toEqual({ day: 3, month: 3 })

    const search = await searchContacts(searchDeps, {
      args: searchContactsInput.parse({ query: 'Fairweather' }),
      token: TOKEN,
    })
    expect(search.content[0]?.text).toContain('birthday: --03-03')

    const upcoming = await listUpcomingBirthdays(
      { ...writeDeps, resolveTimeZone: () => Promise.resolve(null) },
      { args: listUpcomingBirthdaysInput.parse({ days: 7, from: '2027-03-01' }), token: TOKEN }
    )
    expect(upcoming.isError).toBeUndefined()
    expect(upcoming.content[0]?.text).toContain(`${PERSON} — 2027-03-03 (in 2 days)`)
    expect(upcoming.content[0]?.text).toContain(`contact_id: ${contactId}`)
  })

  test('a stored sentinel year 1604 survives the round trip and is read as no year', async () => {
    // Older vCard 3 clients wrote "unknown year" as 1604. This seeds the value
    // over JMAP, so it proves the read-side guard against what Stalwart
    // stores — not whether Stalwart normalises a vCard 3 BDAY on CardDAV
    // import, which needs a raw vCard PUT and is still open.
    await contactCardUpdate({
      ...ctx,
      cardId: contactId,
      patch: { anniversaries: { legacy: { date: { day: 3, month: 3, year: 1604 }, kind: 'birth' } } },
    })
    const [card] = await contactCardGet({ ...ctx, ids: [contactId] })
    expect(readBirthday(card as NonNullable<typeof card>)).toEqual({ day: 3, month: 3 })

    // Clearing it removes the birth entry and leaves nothing behind.
    await updateContact(writeDeps, { args: updateContactInput.parse({ birthday: '', contactId }), token: TOKEN })
    const [cleared] = await contactCardGet({ ...ctx, ids: [contactId] })
    expect(readBirthday(cleared as NonNullable<typeof cleared>)).toBeUndefined()
  })

  // merge_contacts against the real server: the update and the destroy in
  // one ContactCard/set, the `pref` mark surviving the round trip, and a
  // later message from the merged address landing on the kept card.
  test('merge_contacts folds a collected duplicate into the kept card', async () => {
    const OTHER = 'robin.f@example.org'
    const sighting = (id: string) =>
      observationsFromEmail(
        {
          from: [{ email: OTHER, name: 'Robin F.' }],
          id,
          receivedAt: new Date(run - 3_600_000).toISOString(),
          to: [{ email: address }],
        },
        { selfAddresses: new Set([address]) }
      )
    await collectContacts(liveCollectionDeps, ctx, sighting(`m-dup-${run}`))
    const [duplicateId] = await contactCardQuery({ ...ctx, filter: { uid: collectedUid(OTHER) } })
    expect(duplicateId).toBeDefined()

    const result = await mergeContacts(
      { ...searchDeps, ...writeDeps },
      {
        args: mergeContactsInput.parse({ contactId, mergeContactIds: [duplicateId] }),
        token: TOKEN,
      }
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Removed contacts:')
    expect(await contactCardGet({ ...ctx, ids: [duplicateId as string] })).toEqual([])

    const [kept] = await contactCardGet({ ...ctx, ids: [contactId] })
    const emails = Object.values(kept?.emails ?? {})
    expect(emails.map((e) => e.address.toLowerCase()).sort()).toEqual([OTHER, 'robin@northwind.example'])
    // The preferred mark is stored and read back, so the merge did not move it.
    expect(emails.find((e) => e.pref === 1)?.address.toLowerCase()).toBe('robin@northwind.example')
    expect(readCollected(kept as NonNullable<typeof kept>).addresses[OTHER]?.count).toBe(1)

    await untilIndexed(
      () => contactCardQuery({ ...ctx, filter: { email: OTHER } }),
      (found) => found.includes(contactId),
      'the kept contact by its merged address'
    )
    await collectContacts(liveCollectionDeps, ctx, sighting(`m-after-merge-${run}`))
    expect(await contactCardQuery({ ...ctx, filter: { uid: collectedUid(OTHER) } })).toEqual([])
    const [after] = await contactCardGet({ ...ctx, ids: [contactId] })
    expect(readCollected(after as NonNullable<typeof after>).addresses[OTHER]?.count).toBe(2)
  })

  test('delete_contact removes the card from the account', async () => {
    const result = await deleteContact(writeDeps, {
      args: deleteContactInput.parse({ contactId }),
      token: TOKEN,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('nothing will bring it back')
    expect(await contactCardGet({ ...ctx, ids: [contactId] })).toEqual([])

    const search = await untilIndexed(
      () => searchContacts(searchDeps, { args: searchContactsInput.parse({ query: 'Fairweather' }), token: TOKEN }),
      (r) => (r.content[0]?.text ?? '').includes('No contact matched'),
      'the deleted contact dropping out of search'
    )
    expect(search.content[0]?.text).toContain('No contact matched')
  })
})
