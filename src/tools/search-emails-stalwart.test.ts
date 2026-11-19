// E2E for the search_emails email-type filter against a REAL Stalwart
// (ADR 0010). The unit tests prove the enum maps to the right keyword strings
// against fake deps, and the email-agent's live e2e proves the agent writes
// those keywords — but nothing between them proved the halves meet: that
// `keywords: ["ticket"]` becomes a `hasKeyword` condition Stalwart actually
// matches, and that the hit comes back rendering its type as a tag.
//
// The regression this pins down is the one the feature exists to fix. A
// message carrying only the coarse `$label:receipt` agent label — which
// receipt-agent writes for BOTH `receipt` and `order` mail — must NOT match
// `keywords: ["receipt"]` any more, while a message carrying `$type:receipt`
// must. Asserting that against a real Email/query is the only way to know the
// two namespaces are really distinct on the wire rather than just in our
// string helpers.
//
// The read/starred filters are pinned the same way: `read: false` is the only
// caller of JMAP `notKeyword`, and only a live Email/query proves Stalwart
// accepts it inside an AND node rather than answering `unsupportedFilter`.
//
// Paging is pinned last: a walk with the printed cursor must show every
// match exactly once while mail arrives or pages are marked read between
// calls, on mail where several messages share one received second — and a
// multi-term walk must list full matches first, which needs Stalwart's NOT
// filter to split partial matches off.
//
// The MCP tools wrap their OAuth token as `Bearer …`, but a dev-Stalwart
// throwaway account authenticates with a Basic app password — the deps pin
// the Basic credential while everything downstream is the live path.
//
// Skips unless STALWART_ADMIN_URL is set, so a normal `bun test` run stays
// hermetic. Run locally against the shared dev compose
// (infra/dev/stalwart/docker-compose.yml, domain bootstrapped by
// `bun run stalwart:setup`):
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 bun test search-emails-stalwart

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  emailGet,
  emailQuery,
  emailQueryPerTerm,
  emailQueryTotal,
  mailboxIdByNameOrRole,
  makeJmapLive,
} from '../jmap/index.ts'
import { type SearchEmailsDeps, searchEmails } from './search-emails.ts'

const ADMIN_URL = process.env.STALWART_ADMIN_URL
const ADMIN_AUTH =
  process.env.STALWART_ADMIN_AUTHORIZATION ?? `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TOKEN = 'e2e-basic-auth' // ignored — the deps pin Basic auth (see header)

const DAY_MS = 86_400_000
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

const live = ADMIN_URL ? describe : describe.skip

// Tag-line assertions, hoisted per the no-inline-regex rule.
const TAGS_RECEIPT_RE = /tags: .*receipt/u
const TAGS_ORDER_RE = /tags: .*order/u
const NON_WORD_RE = /\W+/gu
const HIT_ID_RE = /^ {3}id: (\S+)$/gmu
const CURSOR_RE = /cursor: "(v1\.[\w-]+)"/u

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

live('search_emails filters and paging against live Stalwart', () => {
  const run = Date.now()
  const localPart = `mcp-search-type-e2e-${run}`
  // The show ran "yesterday"; the booking arrived two days before that. The
  // motivating shape — the confirmation predates the event it confirms.
  const bookingReceivedAt = new Date(run - 3 * DAY_MS)
  const oldTicketReceivedAt = new Date(run - 44 * DAY_MS)

  let address: string
  let authorization: string
  let accountId: string
  let apiUrl: string
  let uploadUrl: string
  let inboxId: string
  let deps: SearchEmailsDeps
  const seeded: Record<string, string> = {}

  // Import one message straight into the Inbox with its keywords already set —
  // the state the email-agent leaves behind after analyzing it.
  const importEmail = async (opts: {
    body: string
    from: string
    keywords: Record<string, boolean>
    receivedAt: Date
    subject: string
  }): Promise<string> => {
    const raw = [
      `From: ${opts.from}`,
      `To: ${address}`,
      `Subject: ${opts.subject}`,
      `Message-ID: <${opts.subject.replaceAll(NON_WORD_RE, '-')}-${run}@mcp-search-type-e2e>`,
      `Date: ${opts.receivedAt.toUTCString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body,
    ].join('\r\n')

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
            {
              accountId,
              emails: {
                i0: {
                  blobId,
                  keywords: opts.keywords,
                  mailboxIds: { [inboxId]: true },
                  receivedAt: opts.receivedAt.toISOString(),
                },
              },
            },
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

  const search = (args: Parameters<typeof searchEmails>[1]['args']) => searchEmails(deps, { args, token: TOKEN })

  const textOf = async (args: Parameters<typeof searchEmails>[1]['args']): Promise<string> =>
    (await search(args)).content[0]?.text ?? ''

  beforeAll(async () => {
    const domainQuery = await adminCall('x:Domain/query', { filter: { name: DOMAIN } })
    const domainId = (domainQuery.ids as string[] | undefined)?.[0]
    if (!domainId) {
      throw new Error(`domain ${DOMAIN} missing — run 'bun run stalwart:setup' first`)
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
      create: { ap1: { allowedIps: {}, description: 'mcp search type e2e', permissions: { '@type': 'Inherit' } } },
    })
    const secret = (minted.created as { ap1?: { secret?: string } } | undefined)?.ap1?.secret
    if (!secret) {
      throw new Error(`app password not created: ${JSON.stringify(minted)}`)
    }
    address = `${localPart}@${DOMAIN}`
    authorization = `Basic ${Buffer.from(`${address}:${secret}`).toString('base64')}`

    const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, { headers: { authorization } })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { apiUrl: string; uploadUrl: string }
    apiUrl = session.apiUrl
    uploadUrl = session.uploadUrl
    accountId = await makeJmapLive(ADMIN_URL as string).resolveAccountId(authorization)

    const resolvedInbox = await mailboxIdByNameOrRole({ accountId, apiUrl, authorization, name: 'Inbox' })
    if (!resolvedInbox) {
      throw new Error('no inbox mailbox on the throwaway account')
    }
    inboxId = resolvedInbox

    // The target: a cinema booking. Nothing in the subject says "ticket" or
    // "cinema" — that is the whole reason the type filter has to carry it.
    seeded.booking = await importEmail({
      body: 'Your seats are reserved. Row 7, seats 12-13.',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      keywords: { $seen: true, '$type:ticket': true },
      receivedAt: bookingReceivedAt,
      subject: 'Booking for Signals from Saturn',
    })

    // Same type, six weeks older: proves the date window is load-bearing and
    // a bare type filter can't pass by accident.
    seeded.oldTicket = await importEmail({
      body: 'Your seats are reserved. Row 2, seat 4.',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      keywords: { $seen: true, '$type:ticket': true },
      receivedAt: oldTicketReceivedAt,
      subject: 'Booking for The Long Quiet',
    })

    // An order carrying ONLY the coarse agent label — exactly what
    // receipt-agent writes for `order`-typed mail. The old enum mapped
    // `receipt` onto `$label:receipt`, so this used to come back as a receipt.
    seeded.orderWithAgentLabel = await importEmail({
      body: 'Your parcel is on its way.',
      from: 'Northwind Supplies <orders@northwind.example>',
      keywords: { '$label:receipt': true, $seen: true, '$type:order': true },
      receivedAt: bookingReceivedAt,
      subject: 'Your order has shipped',
    })

    // A real receipt, typed as one.
    seeded.receipt = await importEmail({
      body: 'Payment received, thank you.',
      from: 'Hosting Co <billing@hosting.example>',
      keywords: { $seen: true, '$type:receipt': true },
      receivedAt: bookingReceivedAt,
      subject: 'Invoice 4021 paid',
    })

    // Keyword bait: the word a free-text query would reach for, on mail that
    // is not a ticket.
    seeded.bait = await importEmail({
      body: 'Kinotickets zum halben Preis, nur diese Woche!',
      from: 'Wochenpost <newsletter@wochenpost.example>',
      keywords: { $seen: true, '$type:newsletter': true },
      receivedAt: bookingReceivedAt,
      subject: 'Diese Woche im Kino',
    })

    // A to-do flag on a typed message — the orthogonal `$label:` value that
    // must keep resolving to the agent-label namespace.
    seeded.todo = await importEmail({
      body: 'Please confirm by Friday.',
      from: 'Acme HR <hr@acme.example>',
      keywords: { '$label:todo': true, $seen: true, '$type:direct': true },
      receivedAt: bookingReceivedAt,
      subject: 'Please confirm your new contract',
    })

    // Untyped, so the type-filter totals above stay as they are: one message
    // nobody has read yet, and one read message the user starred.
    seeded.unread = await importEmail({
      body: 'You have a new message waiting.',
      from: 'Network <messages@network.example>',
      keywords: {},
      receivedAt: bookingReceivedAt,
      subject: 'New message from a recruiter',
    })
    seeded.starred = await importEmail({
      body: 'Keep this for the tax return.',
      from: 'Bank <statements@bank.example>',
      keywords: { $flagged: true, $seen: true },
      receivedAt: bookingReceivedAt,
      subject: 'Annual statement',
    })

    deps = {
      emailGet: (p) => emailGet({ ...p, apiUrl, authorization }),
      emailQuery: (p) => emailQuery({ ...p, apiUrl, authorization }),
      emailQueryPerTerm: (p) => emailQueryPerTerm({ ...p, apiUrl, authorization }),
      emailQueryTotal: (p) => emailQueryTotal({ ...p, apiUrl, authorization }),
      resolveAccountId: () => Promise.resolve(accountId),
      resolveMailbox: async (_authorization, name) => ({
        available: [],
        id: await mailboxIdByNameOrRole({ accountId, apiUrl, authorization, name }),
      }),
    }
  })

  afterAll(async () => {
    // Throwaway principal; destroying it also drops its mail. Always query by
    // name (never gate on late-assigned state) so a beforeAll that failed
    // after account creation still cleans up.
    const query = await adminCall('x:Account/query', { filter: { name: localPart } })
    const ids = (query.ids as string[] | undefined) ?? []
    if (ids.length > 0) {
      await adminCall('x:Account/set', { destroy: ids })
    }
  })

  test('a type filter alone finds the booking Stalwart has no text match for', async () => {
    const text = await textOf({ keywords: ['ticket'], limit: 20 })

    expect(text).toContain(seeded.booking as string)
    expect(text).toContain('Booking for Signals from Saturn')
    // Only ticket-typed mail — the newsletter advertising "Kinotickets" is
    // typed `newsletter` and stays out.
    expect(text).not.toContain(seeded.bait as string)
    expect(text).not.toContain(seeded.receipt as string)
  })

  test('the type filter composes with a received-date window', async () => {
    // Widened by a booking lead time: it contains the confirmation's arrival
    // without reaching back to the six-week-old show.
    const text = await textOf({
      after: new Date(run - 21 * DAY_MS).toISOString(),
      before: new Date(run).toISOString(),
      keywords: ['ticket'],
      limit: 20,
    })

    expect(text).toContain(seeded.booking as string)
    expect(text).not.toContain(seeded.oldTicket as string)
  })

  // The conflation this feature fixes: `receipt` used to mean "whatever
  // receipt-agent labeled", which included orders.
  test('receipt returns only receipts — an order carrying $label:receipt no longer matches', async () => {
    const text = await textOf({ keywords: ['receipt'], limit: 20 })

    expect(text).toContain(seeded.receipt as string)
    expect(text).not.toContain(seeded.orderWithAgentLabel as string)
  })

  test('order returns the order the coarse label used to hide', async () => {
    const text = await textOf({ keywords: ['order'], limit: 20 })

    expect(text).toContain(seeded.orderWithAgentLabel as string)
    expect(text).not.toContain(seeded.receipt as string)
  })

  test('todo still resolves to the $label: agent flag, not a $type: keyword', async () => {
    const text = await textOf({ keywords: ['todo'], limit: 20 })

    expect(text).toContain(seeded.todo as string)
    expect(text).not.toContain(seeded.booking as string)
  })

  test('several types OR together', async () => {
    const text = await textOf({ keywords: ['ticket', 'receipt'], limit: 20 })

    expect(text).toContain(seeded.booking as string)
    expect(text).toContain(seeded.receipt as string)
    expect(text).not.toContain(seeded.bait as string)
  })

  test('a hit renders its type as a tag, with the agent label deduplicated', async () => {
    const ticket = await textOf({ keywords: ['ticket'], limit: 20 })
    expect(ticket).toContain('tags: ticket')

    // The order carries both `$label:receipt` and `$type:order`, so both
    // render — but `$seen` never does, and neither namespace's prefix leaks.
    const order = await textOf({ keywords: ['order'], limit: 20 })
    expect(order).toMatch(TAGS_RECEIPT_RE)
    expect(order).toMatch(TAGS_ORDER_RE)
    expect(order).not.toContain('$seen')
    expect(order).not.toContain('$type:')
    expect(order).not.toContain('$label:')
  })

  // Two ticket-typed messages, a page of one: the header must report the real
  // total from Stalwart, not the page size.
  test('a full page reports the total number of matches and how many were cut off', async () => {
    const text = await textOf({ keywords: ['ticket'], limit: 1 })

    expect(text).toStartWith('1 of 2 message(s) matched — 1 more not shown.')
  })

  // A full page asks Stalwart for the count; it must agree nothing was cut off.
  test('a full page that holds every match reports the total without a truncation note', async () => {
    const text = await textOf({ keywords: ['ticket'], limit: 2 })

    expect(text).toStartWith('2 of 2 message(s) matched:')
    expect(text).not.toContain('not shown')
  })

  test('a type with no mail returns the empty-result message, not an error', async () => {
    const result = await search({ keywords: ['security_alert'], limit: 20 })

    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.text).toBe('No messages matched.')
  })

  test('read: false finds only the unread message, through notKeyword', async () => {
    const result = await search({ limit: 20, read: false })
    const text = result.content[0]?.text ?? ''

    expect(result.isError).toBeFalsy()
    expect(text).toStartWith('1 of 1 message(s) matched:')
    expect(text).toContain(seeded.unread as string)
    expect(text).toContain('flags: unread')
  })

  test('read: true leaves the unread message out', async () => {
    const text = await textOf({ limit: 20, read: true })

    expect(text).toContain(seeded.booking as string)
    expect(text).not.toContain(seeded.unread as string)
  })

  test('starred: true finds only the starred message and shows its flag', async () => {
    const text = await textOf({ limit: 20, starred: true })

    expect(text).toStartWith('1 of 1 message(s) matched:')
    expect(text).toContain(seeded.starred as string)
    expect(text).toContain('flags: starred')
  })

  test('read composes with the other filters', async () => {
    const result = await search({ keywords: ['ticket'], limit: 20, read: false })

    expect(result.content[0]?.text).toBe('No messages matched.')
  })

  // --- paging (#942) — kept last: it adds mail the counts above don't expect.

  // Walk every page of one search, calling `between` after each page, and
  // return the ids in the order they were shown.
  const walk = async (
    args: Omit<Parameters<typeof searchEmails>[1]['args'], 'cursor'>,
    between: (pageIds: string[]) => Promise<void> = () => Promise.resolve()
  ): Promise<{ ids: string[]; pages: number }> => {
    const ids: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const result = await search({ ...args, ...(cursor ? { cursor } : {}) })
      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      const pageIds = [...text.matchAll(HIT_ID_RE)].map((m) => m[1] as string)
      ids.push(...pageIds)
      pages += 1
      await between(pageIds)
      cursor = CURSOR_RE.exec(text)?.[1]
    } while (cursor && pages < 20)
    return { ids, pages }
  }

  const setSeen = async (id: string): Promise<void> => {
    const res = await fetch(apiUrl, {
      body: JSON.stringify({
        methodCalls: [['Email/set', { accountId, update: { [id]: { 'keywords/$seen': true } } }, '0']],
        using: USING,
      }),
      headers: { authorization, 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(res.status).toBe(200)
  }

  test('pages of two cover every seeded message once, seven of them sharing one received second', async () => {
    const { ids, pages } = await walk({ after: new Date(run - 60 * DAY_MS).toISOString(), limit: 2 })

    expect(pages).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(Object.values(seeded).sort())
  })

  test('mail arriving between pages neither repeats nor skips a hit', async () => {
    let arrived: string | undefined
    const { ids } = await walk({ after: new Date(run - 60 * DAY_MS).toISOString(), limit: 3 }, async () => {
      arrived ??= await importEmail({
        body: 'Fresh in while the agent was paging.',
        from: 'Courier <news@courier.example>',
        keywords: { $seen: true },
        receivedAt: new Date(),
        subject: 'Arrived mid-walk',
      })
    })

    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(Object.values(seeded).sort())
    // Newer than the walk's first page, so it belongs to the next search.
    expect(ids).not.toContain(arrived as string)
    seeded.arrived = arrived as string
  })

  test('marking each unread page read does not cost the next page a hit', async () => {
    for (const [i, days] of [5, 6, 7].entries()) {
      seeded[`unread${i}`] = await importEmail({
        body: 'Another unread notice.',
        from: 'Network <messages@network.example>',
        keywords: {},
        receivedAt: new Date(run - days * DAY_MS),
        subject: `Unread notice ${i}`,
      })
    }
    const unread = [seeded.unread, seeded.unread0, seeded.unread1, seeded.unread2] as string[]

    const { ids, pages } = await walk({ limit: 1, read: false }, async (pageIds) => {
      for (const id of pageIds) {
        await setSeen(id)
      }
    })

    expect(pages).toBe(4)
    expect([...ids].sort()).toEqual([...unread].sort())
  })

  test('a multi-term walk lists the older full match before the newer partial one', async () => {
    // Stalwart indexes full text a moment after import; wait until both
    // matches are searchable so the walk sees the whole result.
    const ready = async (): Promise<boolean> => (await textOf({ limit: 20, query: 'Quiet seats' })).startsWith('2 of 2')
    for (let tries = 0; tries < 20 && !(await ready()); tries++) {
      await Bun.sleep(500)
    }
    expect(await ready()).toBe(true)

    // The six-week-old show holds both terms; the newer booking only "seats".
    const { ids, pages } = await walk({ limit: 1, query: 'Quiet seats' })

    expect(pages).toBe(2)
    expect(ids).toEqual([seeded.oldTicket, seeded.booking].map(String))
  })

  // A quoted phrase reaches Stalwart quoted, so it matches the words only
  // next to each other and in order — not a message holding them apart.
  // Imported last and kept out of `seeded`, so the walks above are unaffected.
  test('a quoted phrase matches the phrase, not the same words apart', async () => {
    const phrase = await importEmail({
      body: 'Thanks for visiting Quillfern Teapot Atelier today.',
      from: 'Shop <hello@shop.example>',
      keywords: { $seen: true },
      receivedAt: bookingReceivedAt,
      subject: 'Your visit',
    })
    const apart = await importEmail({
      body: 'The atelier sold me a teapot glazed in quillfern green.',
      from: 'Forum <digest@forum.example>',
      keywords: { $seen: true },
      receivedAt: bookingReceivedAt,
      subject: 'Weekly digest',
    })
    // Both hold all three words, which the unquoted search proves once
    // Stalwart has indexed them.
    const unquoted = async (): Promise<string> => await textOf({ limit: 20, query: 'quillfern teapot atelier' })
    for (let tries = 0; tries < 20 && !(await unquoted()).startsWith('2 of 2'); tries++) {
      await Bun.sleep(500)
    }
    const loose = await unquoted()
    expect(loose).toContain(phrase)
    expect(loose).toContain(apart)

    const text = await textOf({ limit: 20, query: '"quillfern teapot atelier"' })

    expect(text).toStartWith('1 of 1 message(s) matched:')
    expect([...text.matchAll(HIT_ID_RE)].map((m) => m[1])).toEqual([phrase])
    expect(apart).not.toBe(phrase)
  })
})
