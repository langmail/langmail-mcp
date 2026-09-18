// search_contacts tool — resolves a name, partial name, address, or
// organization to known contacts from the collected address book (built by
// the email-agent and the calendar tools) plus any personal address books,
// ranked by the read-time scoring in @langmail/contacts. Judgments
// (relationship label, ranking, relative ages) are computed here, tool-side;
// what the caller gets raw is the concrete recent-interaction list, hydrated
// from the content-free record ids stored on the card.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  type AddressCandidate,
  addressCandidates,
  bestAddress,
  type CollectedExtension,
  type InteractionTuple,
  rankCards,
  readCollected,
  readOrganization,
  relationshipFor,
  relativeAge,
  SHOWN_INTERACTIONS,
  sourceOf,
} from '@langmail/contacts'
import { parseEvents } from '@langmail/ical'
import {
  accountIdForContacts,
  bearerAuthorization,
  type ContactCard,
  type ContactCardFilter,
  type ContactCardGetParams,
  type ContactCardQueryParams,
  contactCardGet,
  contactCardQuery,
  type EmailGetParams,
  type EmailRecord,
  emailGet,
  type JmapLive,
} from '@langmail/jmap'

import { type CalDavConfig, discoverAccount, fetchEvents } from '../caldav/client.ts'
import { READ_ONLY } from './annotations.ts'
import { birthdayLine, profileLines } from './contact-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const searchContactsShape = {
  context: z
    .enum(['work', 'private', 'any'])
    .default('any')
    .describe(
      'Biases address ranking when a person has addresses in several contexts. ' +
        '`work` prefers organization-domain addresses; `private` prefers ' +
        'personal-domain addresses. Never filters a person out entirely.'
    ),
  limit: z.number().int().min(1).max(25).default(5).describe('Maximum number of matching people.'),
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Name, partial name, email address, or organization. Matched against ' +
        'display names, addresses, and address domains.'
    ),
  response_format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      '`concise` returns name, contact id, best address, confidence, relationship, ' +
        'and the last interactions. `detailed` adds all known addresses with their ' +
        'own confidence, phone numbers, postal addresses, the note, where the record ' +
        'came from, and interaction record ids (for chaining into get_email or ' +
        'list_calendar_events), plus excluded relay addresses.'
    ),
}

export const searchContactsInput = z.object(searchContactsShape)

export type SearchContactsArgs = z.infer<typeof searchContactsInput>

export interface SearchContactsDeps {
  contactCardGet: (p: ContactCardGetParams) => Promise<ContactCard[]>
  contactCardQuery: (p: ContactCardQueryParams) => Promise<string[]>
  emailGet: (p: EmailGetParams) => Promise<EmailRecord[]>
  // Titles for the named event UIDs, resolved in ONE pass over the
  // principal's calendars — a per-UID lookup would re-discover the CalDAV
  // account and re-read whole collections for every interaction line.
  // Missing UIDs are simply absent from the map; hydration is best-effort
  // and must never fail the search.
  fetchEventTitles: (token: string, uids: string[]) => Promise<Map<string, string>>
  // Contacts-capability account id for the bearer.
  resolveAccountId: (authorization: string) => Promise<string>
  // Mail-capability account id (subjects hydrate over Email/get).
  resolveMailAccountId: (authorization: string) => Promise<string>
}

export interface SearchContactsContext {
  args: SearchContactsArgs
  token: string
}

// Fetch window before ranking: ranking needs the whole candidate set, not
// just the first page the server happens to return.
const QUERY_WINDOW = 50

// Window for the unfiltered sweep (see below). Bounded rather than
// unbounded: past this size the filtered read is what still reaches a card.
const SWEEP_WINDOW = 250

// Client-side refinement of the server-side candidate set, and the final
// word on what matched: the server's `text` condition also searches notes,
// and every collected card carries the same machine-written note text, so
// trusting a bare server hit would answer "Collection" with the whole book.
// This mirrors the fields the description promises: display name,
// organization, address, and address domain.
const matchesQuery = (card: ContactCard, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (card.name?.full?.toLowerCase().includes(q)) {
    return true
  }
  if (Object.values(card.organizations ?? {}).some((o) => o.name?.toLowerCase().includes(q))) {
    return true
  }
  return Object.values(card.emails ?? {}).some((e) => {
    const address = e.address.toLowerCase()
    return address.includes(q) || (address.split('@')[1] ?? '').includes(q)
  })
}

const emptyResultText = (query: string): string =>
  `No contact matched "${query}" in the collected address book (built from mail headers and calendar attendees) or the personal address books. ` +
  'If you know part of the address or the organization, search for that instead. ' +
  "If the person has only contacted the user via LinkedIn or another platform, no email address exists in this account's data."

// Hydrated, relative-dated prose for one interaction tuple.
const interactionLine = (
  tuple: InteractionTuple,
  subjects: Map<string, string | null>,
  eventTitles: Map<string, string>,
  now: Date
): string => {
  const age = relativeAge(tuple.date, now)
  if (tuple.channel === 'calendar') {
    const title = eventTitles.get(tuple.recordId)
    return `${age} — calendar: ${title ?? '(event no longer available)'}`
  }
  const subject = subjects.get(tuple.recordId)
  const verb = tuple.direction === 'outgoing' ? 'email sent' : 'email received'
  return `${age} — ${verb}: ${subject ?? '(message no longer available)'}`
}

interface Hydrated {
  eventTitles: Map<string, string>
  subjects: Map<string, string | null>
}

// One batched Email/get for the subjects and one calendar pass for the
// titles — only for the matched people (at most `limit`), never for the
// whole book, and never per interaction line.
const hydrate = async (
  deps: SearchContactsDeps,
  auth: { authorization: string; token: string },
  tuples: InteractionTuple[]
): Promise<Hydrated> => {
  const emailIds = [...new Set(tuples.filter((t) => t.channel === 'email').map((t) => t.recordId))]
  const eventUids = [...new Set(tuples.filter((t) => t.channel === 'calendar').map((t) => t.recordId))]
  const subjects = new Map<string, string | null>()
  let eventTitles = new Map<string, string>()
  if (emailIds.length > 0) {
    try {
      const mailAccountId = await deps.resolveMailAccountId(auth.authorization)
      const records = await deps.emailGet({
        accountId: mailAccountId,
        apiUrl: '',
        authorization: auth.authorization,
        ids: emailIds,
      })
      for (const r of records) {
        subjects.set(r.id, r.subject ?? null)
      }
    } catch {
      // Best-effort: lines degrade to "(message no longer available)".
    }
  }
  if (eventUids.length > 0) {
    try {
      eventTitles = await deps.fetchEventTitles(auth.token, eventUids)
    } catch {
      // Best-effort: lines degrade to "(event no longer available)".
    }
  }
  return { eventTitles, subjects }
}

const confidenceOf = (card: ContactCard, args: SearchContactsArgs): AddressCandidate | undefined =>
  bestAddress(card, args.context)

const concisePerson = (
  card: ContactCard,
  ext: CollectedExtension,
  args: SearchContactsArgs,
  hydrated: Hydrated,
  now: Date,
  index: number
): string => {
  const best = confidenceOf(card, args)
  const lines = ext.interactions
    .slice(0, SHOWN_INTERACTIONS)
    .map((t) => `   - ${interactionLine(t, hydrated.subjects, hydrated.eventTitles, now)}`)
  const organization = readOrganization(card)
  const birthday = birthdayLine(card)
  return [
    `${index + 1}. ${card.name?.full ?? best?.address ?? '(unnamed)'}`,
    // The handle create_contact/update_contact/delete_contact address the
    // record by — in the concise format too, so editing a contact never
    // costs an extra detailed round-trip.
    `   contact_id: ${card.id}`,
    ...(organization ? [`   organization: ${organization}`] : []),
    // One short line, only when stored: "when is Robin's birthday" should
    // not need the detailed format.
    ...(birthday ? [birthday] : []),
    `   best_address: ${best?.address ?? '(none)'} (${best?.context ?? 'unknown'})`,
    `   address_confidence: ${best?.confidence ?? 'weak'} | relationship: ${relationshipFor(ext, now)}`,
    ...(lines.length > 0 ? ['   last_interactions:', ...lines] : []),
  ].join('\n')
}

const detailedPerson = (
  card: ContactCard,
  ext: CollectedExtension,
  args: SearchContactsArgs,
  hydrated: Hydrated,
  now: Date,
  index: number
): string => {
  const parts = [concisePerson(card, ext, args, hydrated, now, index)]
  const candidates = addressCandidates(card)
  if (candidates.length > 0) {
    parts.push('   addresses:')
    for (const c of candidates) {
      const seen = c.lastSeen ? `, last seen ${relativeAge(c.lastSeen, now)}` : ''
      parts.push(`   - ${c.address} (${c.context}, ${c.confidence}${seen})`)
    }
  }
  // The authored half of the record — phones, postal addresses, note. Only
  // in the detailed format: an agent resolving a name before drafting mail
  // has no use for a street address, and the concise format is what that
  // call reads. The birthday is already on the concise block above.
  parts.push(...profileLines(card, { birthday: false }))
  // Provenance, because `confidence` means different things across sources:
  // on a derived address it is an inference from headers, on an authored one
  // it is the user's own assertion.
  parts.push(`   source: ${sourceOf(card)}`)
  const withIds = ext.interactions.map(
    (t) =>
      `   - ${interactionLine(t, hydrated.subjects, hydrated.eventTitles, now)} [${
        t.channel === 'email' ? 'email id' : 'event uid'
      }: ${t.recordId}]`
  )
  if (withIds.length > 0) {
    parts.push('   interaction_records:', ...withIds)
  }
  if (ext.relays && ext.relays.length > 0) {
    parts.push(`   excluded_relays: ${ext.relays.join(', ')} (relay addresses, not usable for direct contact)`)
  }
  return parts.join('\n')
}

export const searchContacts = async (deps: SearchContactsDeps, ctx: SearchContactsContext): Promise<ToolResult> => {
  const { args, token } = ctx
  const query = args.query.trim()
  if (query.length === 0) {
    return errorResult('query must not be empty.')
  }
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)

  // Two candidate sets, unioned, then refined client-side by `matchesQuery`
  // — which is the authority either way, because the server's `text`
  // condition also hits the machine-written note every collected card
  // carries. All address books are queried, collected and personal alike.
  //
  // The filtered read reaches cards past the sweep window on a large book.
  // The unfiltered sweep reaches cards the filter structurally cannot see:
  // Stalwart does not return a card with no `emails` property for a query on
  // its display name, which is exactly what create_contact writes from a name
  // and a postal address. Neither is a superset of the other, so a search
  // that ran only one of them would silently drop people — the sweep alone
  // would truncate a big book, and the filter alone would hide every
  // emailless contact that shares a query term with an addressed one.
  // Queries return ids only; the single `get` below is the real cost.
  const ids = async (filter: ContactCardFilter | undefined, limit: number): Promise<string[]> =>
    deps.contactCardQuery({ accountId, apiUrl: '', authorization, ...(filter ? { filter } : {}), limit })

  const [filteredIds, sweptIds] = await Promise.all([
    ids({ conditions: [{ text: query }, { email: query }, { name: query }], operator: 'OR' }, QUERY_WINDOW),
    ids(undefined, SWEEP_WINDOW),
  ])
  const candidateIds = [...new Set([...filteredIds, ...sweptIds])]
  const cards = await deps.contactCardGet({ accountId, apiUrl: '', authorization, ids: candidateIds })
  const matched = cards.filter((c) => matchesQuery(c, query))
  if (matched.length === 0) {
    return textResult(emptyResultText(query))
  }
  // Either window coming back full means the count below is a floor.
  const windowFull = filteredIds.length >= QUERY_WINDOW || sweptIds.length >= SWEEP_WINDOW

  const now = new Date()
  const ranked = rankCards(matched, now)
  const page = ranked.slice(0, args.limit)

  const shown = args.response_format === 'detailed' ? undefined : SHOWN_INTERACTIONS
  const tuples = page.flatMap((card) => {
    const interactions = readCollected(card).interactions
    return shown === undefined ? interactions : interactions.slice(0, shown)
  })
  const hydrated = await hydrate(deps, { authorization, token }, tuples)

  const render = args.response_format === 'detailed' ? detailedPerson : concisePerson
  const sections = page.map((card, i) => render(card, readCollected(card), args, hydrated, now, i))

  // The candidate window caps what we can count, so say "at least" when the
  // window was full rather than understating a very ambiguous query.
  const atLeast = windowFull ? 'at least ' : ''
  const truncationNote =
    ranked.length > args.limit
      ? `\n\nShowing the top ${args.limit} of ${atLeast}${ranked.length} matches — narrow the query (add a surname, address fragment, or organization) to disambiguate.`
      : ''
  const relayNote = page.some((card) => (readCollected(card).relays?.length ?? 0) > 0)
    ? '\n\nNote: relay addresses (e.g. LinkedIn digests) were excluded as unusable; detailed format lists them.'
    : ''
  return textResult(`${page.length} person(s) matched:\n\n${sections.join('\n\n')}${relayNote}${truncationNote}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive, caldav: CalDavConfig): SearchContactsDeps => ({
  contactCardGet: async (p) => contactCardGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  contactCardQuery: async (p) => contactCardQuery({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailGet: async (p) => emailGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  fetchEventTitles: async (token, uids) => {
    // One discovery and at most one read per calendar, default first,
    // stopping as soon as every UID is resolved — the whole point of the
    // batch shape (a per-UID lookup re-read every collection).
    const wanted = new Set(uids)
    const titles = new Map<string, string>()
    const account = await discoverAccount(caldav, token)
    const urls = [
      ...(account.defaultCalendarUrl ? [account.defaultCalendarUrl] : []),
      ...account.calendars.map((c) => c.url).filter((u) => u !== account.defaultCalendarUrl),
    ]
    for (const calendarUrl of urls) {
      if (titles.size === wanted.size) {
        break
      }
      for (const object of await fetchEvents(caldav, { calendarUrl, token })) {
        for (const event of parseEvents(object.data)) {
          if (wanted.has(event.uid) && !titles.has(event.uid) && event.title) {
            titles.set(event.uid, event.title)
          }
        }
      }
    }
    return titles
  },
  resolveAccountId: async (authorization) => accountIdForContacts(await live.getSession(authorization)),
  resolveMailAccountId: live.resolveAccountId,
})

// --- MCP registration ----------------------------------------------------

export const registerSearchContacts = (
  server: McpServer,
  deps: SearchContactsDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'search_contacts',
    {
      annotations: READ_ONLY,
      description:
        "Resolve a person's name, partial name, email address, or organization to " +
        'known contacts, ranked by interaction recency and frequency. Sources ' +
        'include the collected address book maintained from mail headers (both ' +
        'directions, including Sent) and calendar attendees and organizers, plus ' +
        "the user's personal address books, and contacts written with " +
        'create_contact. Use this before creating events or drafting mail when only ' +
        'a name is known, and before create_contact or update_contact to get the ' +
        'contact_id. Returns for each contact one or more addresses with a ' +
        'confidence level, the birthday when one is stored, and recent ' +
        'interactions; the detailed format adds phone numbers, postal addresses ' +
        'and the note. Do not use it to enumerate all contacts; a query is ' +
        'required, and for "whose birthday is coming up" use ' +
        'list_upcoming_birthdays instead. If several plausible people match, ' +
        'present the candidates to the user rather than guessing.',
      inputSchema: searchContactsShape,
      title: 'Search contacts',
    },
    (args) => searchContacts(deps, { args: searchContactsInput.parse(args), token: getToken() })
  )
}
