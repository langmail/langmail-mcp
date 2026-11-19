// search_contacts tool — resolves a name, partial name, address, or
// organization to known contacts from the collected address book (built by
// the email-agent and the calendar tools) plus any personal address books,
// ranked by the read-time scoring in src/contacts. Judgments
// (relationship label, ranking, relative ages) are computed here, tool-side;
// what the caller gets raw is the concrete recent-interaction list, hydrated
// from the content-free record ids stored on the card.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { type CalDavConfig, discoverAccount, fetchEvents } from '../caldav/client.ts'
import {
  type AddressCandidate,
  addressCandidates,
  bestAddress,
  COLLECTED_BOOK_NAME,
  type CollectedExtension,
  hasRole,
  type InteractionTuple,
  isRolePhrase,
  normalizeRole,
  rankCards,
  readCollected,
  readOrganization,
  relationshipFor,
  relativeAge,
  SHOWN_INTERACTIONS,
  sourceOf,
} from '../contacts/index.ts'
import { parseEvents } from '../ical/index.ts'
import {
  type AddressBookRecord,
  accountIdForContacts,
  addressBookList,
  bearerAuthorization,
  type ContactCard,
  type ContactCardGetParams,
  type ContactCardPage,
  type ContactCardPageParams,
  contactCardGet,
  contactCardPage,
  type EmailGetParams,
  type EmailHeaderRecord,
  type EmailHeadersMatchingParams,
  type EmailRecord,
  emailGet,
  emailHeadersMatching,
  type JmapLive,
} from '../jmap/index.ts'
import { logger } from '../logger/index.ts'
import { type ServerMode } from '../mode.ts'
import { READ_ONLY } from './annotations.ts'
import { birthdayLine, profileLines, rolesLine } from './contact-format.ts'
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
      'Name, partial name, email address, organization, or what the person is to the user ' +
        '("lawyer", "my landlord"). Matched against display names, organizations, addresses, ' +
        'address domains, and the roles stored on contacts.'
    ),
  response_format: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      '`concise` returns name, contact id, roles, best address, confidence, relationship, ' +
        'the birthday when stored, and the last interactions. `detailed` adds all known addresses with their ' +
        'own confidence, phone numbers, postal addresses, the note, where the record ' +
        'came from, and interaction record ids (for chaining into get_email or ' +
        'list_calendar_events), plus excluded relay addresses.'
    ),
}

export const searchContactsInput = z.object(searchContactsShape)

export type SearchContactsArgs = z.infer<typeof searchContactsInput>

export interface SearchContactsDeps {
  // The Collected book's id tells an old Collected card without a source
  // marker apart from an imported one.
  addressBookList: (p: { accountId: string; apiUrl: string; authorization: string }) => Promise<AddressBookRecord[]>
  contactCardGet: (p: ContactCardGetParams) => Promise<ContactCard[]>
  contactCardPage: (p: ContactCardPageParams) => Promise<ContactCardPage>
  emailGet: (p: EmailGetParams) => Promise<EmailRecord[]>
  // The From, To and Cc of the newest messages whose headers match, newest
  // first. Self-hosted only: the fallback when no card matches.
  emailHeadersMatching: (p: EmailHeadersMatchingParams) => Promise<EmailHeaderRecord[]>
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
  // Words the no-match text for the server it runs on; hosted when left out.
  mode?: ServerMode
  token: string
}

// The search reads every card in the account and decides the match itself
// (`matchesQuery`), rather than asking the server to filter. Stalwart's
// query cannot reach a role (`text` does not search `titles`, and there is
// no title condition: docs/upstream/stalwart/contact-query-cannot-match-titles.md),
// its filtered ids come back unranked, so a window of them can drop the best
// match, and its name, email and text conditions go through a search index
// that misses a card for a moment after it is written. An unfiltered page
// has none of these limits.
//
// Ids per page, and per full get below: Stalwart's default
// `maxObjectsInGet` is 500.
const PAGE = 500

// Upper bound on the cards one search reads. Past it the result says the
// rest of the book was not searched.
const CARD_CAP = 50_000

// Pages in flight at once. Stalwart advertises four concurrent requests per
// account (`maxConcurrentRequests`; 1.1.0 refused only past eight), and an
// agent may run two searches at once while the email-agent writes to the
// same account.
const PARALLEL_PAGES = 2

// What `matchesQuery` reads. The rest of a card (the collected interaction
// log above all) is read only for the matches.
const MATCH_PROPERTIES = ['id', 'name', 'organizations', 'emails', 'titles']

// The ids of every card that matches the query, in the book's order, and
// whether the sweep stopped at CARD_CAP with cards left unread. On a
// 5,000-card book that is one page, then five rounds of two pages.
const sweepBook = async (
  deps: Pick<SearchContactsDeps, 'contactCardPage'>,
  ctx: { accountId: string; authorization: string },
  query: string
): Promise<{ capped: boolean; matched: string[] }> => {
  const seen = new Set<string>()
  const matched: string[] = []
  const read = async (at: number, limit: number): Promise<ContactCardPage> => {
    const page = await deps.contactCardPage({ ...ctx, apiUrl: '', limit, position: at, properties: MATCH_PROPERTIES })
    for (const card of page.cards) {
      // A card read twice (a page re-read after a short one) counts once.
      if (!seen.has(card.id)) {
        seen.add(card.id)
        if (matchesQuery(card, query)) {
          matched.push(card.id)
        }
      }
    }
    return page
  }
  const first = await read(0, PAGE)
  const { total } = first
  // A server whose query limit is below PAGE returns shorter pages that are
  // not the end, so the first page's length is the page size from here on.
  const size = first.returned
  const end = Math.min(total ?? Number.POSITIVE_INFINITY, CARD_CAP)
  let position = first.returned
  let done = first.returned === 0 || (total !== undefined && position >= total)
  while (!done && position < end) {
    const starts: number[] = []
    for (let at = position; at < end && starts.length < PARALLEL_PAGES; at += size) {
      starts.push(at)
    }
    const requests = starts.map((at) => ({ at, limit: Math.min(size, CARD_CAP - at) }))
    const pages = await Promise.all(requests.map((r) => read(r.at, r.limit)))
    const shortAt = pages.findIndex((page, i) => page.returned < (requests[i]?.limit ?? 0))
    const short = pages[shortAt]
    const request = requests[shortAt]
    if (short && request) {
      // The end of the book, or a server trimming a page: carry on right
      // after what came back, until a page comes back empty.
      position = request.at + short.returned
      done = short.returned === 0
    } else {
      position = (starts.at(-1) ?? position) + size
    }
    done ||= total !== undefined && position >= total
  }
  return { capped: !done && position >= CARD_CAP, matched }
}

// Full cards for the sweep's matches, read in gets of at most PAGE ids.
const getInPages = async (
  deps: Pick<SearchContactsDeps, 'contactCardGet'>,
  ctx: { accountId: string; authorization: string },
  ids: string[]
): Promise<ContactCard[]> => {
  const cards: ContactCard[] = []
  for (let i = 0; i < ids.length; i += PAGE) {
    cards.push(...(await deps.contactCardGet({ ...ctx, apiUrl: '', ids: ids.slice(i, i + PAGE) })))
  }
  return cards
}

// What matches, over the fields the description promises: display name,
// organization, address, address domain, and role (`hasRole`, which drops a
// leading "my " from the query). Notes are not among them: every collected
// card carries the same machine-written note text, so a note hit would
// answer "Collection" with the whole book.
const matchesQuery = (card: ContactCard, query: string): boolean =>
  hasRole(card, query) || matchesByName(card, query) || matchesByAddress(card, query)

const matchesByName = (card: ContactCard, query: string): boolean => {
  const q = withoutMy(query)
  return (
    card.name?.full?.toLowerCase().includes(q) === true ||
    Object.values(card.organizations ?? {}).some((o) => o.name?.toLowerCase().includes(q))
  )
}

const matchesByAddress = (card: ContactCard, query: string): boolean => {
  const q = withoutMy(query)
  return Object.values(card.emails ?? {}).some((e) => {
    const address = e.address.toLowerCase()
    return address.includes(q) || (address.split('@')[1] ?? '').includes(q)
  })
}

// How the agent gets from "my lawyer" to a person the first time, before a
// role is stored. A role is recorded only on the user's word: a guess would
// send their mail to the wrong person.
const roleHint =
  'If the query is what the person is to the user (e.g. "my lawyer"), find them with search_emails, ' +
  'confirm with the user who it is, then record it with update_contact `addedRoles` ' +
  '(or create_contact `roles`) so the next request takes one lookup.'

// `capped` is true when the sweep stopped at CARD_CAP, where a match may be
// out of sight.
// Self-hosted, nothing builds a collected book: every book is the user's own.
const searchedBooks = (mode: ServerMode): string =>
  mode === 'hosted'
    ? 'the collected address book (built from mail headers and calendar attendees) or the personal address books'
    : 'any address book'

// Self-hosted, nothing fills an address book from mail, so a person the user
// has only exchanged mail with has no card. When no card matches, the search
// reads the From, To and Cc of the newest messages whose headers match, and
// returns the people there, marked as not saved. Nothing is written.
const MAIL_MESSAGES = 50

// `searchedMail` is true when the mail headers were searched too and turned
// up no one.
const emptyResultText = (query: string, capped: boolean, mode: ServerMode, searchedMail = false): string =>
  `No contact matched "${query}" in ${searchedBooks(mode)}${capped ? '' : ', and no contact has it as a role'}. ` +
  (searchedMail
    ? `No one in the From, To or Cc of the newest ${MAIL_MESSAGES} matching messages in the mailbox matched it either. `
    : '') +
  'If you know part of the address or the organization, search for that instead. ' +
  `${roleHint} ` +
  "If the person has only contacted the user via LinkedIn or another platform, no email address exists in this account's data."

// --- Self-hosted fallback: people found in mail headers -------------------

interface MailPerson {
  address: string
  lastSeen: string
  messages: number
  name?: string
}

// Every word of the query must be in the person's name or address: a message
// matched by its headers also names everyone else on it.
const matchesPerson = (entry: { email: string; name?: string | null }, words: string[]): boolean => {
  const text = `${entry.name ?? ''} ${entry.email}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

const SPACES = /\s+/u

// Counts one sighting of `entry` on a message received at `date`.
const sight = (people: Map<string, MailPerson>, entry: { email: string; name?: string | null }, date: string): void => {
  const key = entry.email.toLowerCase()
  const name = entry.name?.trim() || undefined
  const known = people.get(key)
  if (!known) {
    people.set(key, { address: entry.email, lastSeen: date, messages: 1, ...(name ? { name } : {}) })
    return
  }
  known.messages += 1
  // The newest message's display name wins.
  if (date > known.lastSeen) {
    known.lastSeen = date
    known.name = name ?? known.name
  } else {
    known.name ??= name
  }
}

// The distinct people in `messages` that match `query`, last seen first.
export const peopleInMail = (messages: EmailHeaderRecord[], query: string): MailPerson[] => {
  const words = withoutMy(query).split(SPACES).filter(Boolean)
  const people = new Map<string, MailPerson>()
  for (const message of messages) {
    const entries = [...(message.from ?? []), ...(message.to ?? []), ...(message.cc ?? [])]
    for (const entry of entries.filter((e) => e.email && matchesPerson(e, words))) {
      sight(people, entry, message.receivedAt ?? '')
    }
  }
  return [...people.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
}

const mailPersonBlock = (person: MailPerson, now: Date, index: number): string =>
  [
    `${index + 1}. ${person.name ?? person.address}`,
    '   contact_id: (none, not saved as a contact)',
    `   address: ${person.address}`,
    '   source: found in mail headers (From, To, Cc), not in any address book',
    `   last_seen: ${person.lastSeen ? relativeAge(person.lastSeen, now) : 'unknown date'} (${person.messages} message${person.messages === 1 ? '' : 's'})`,
  ].join('\n')

// The fallback's result, or undefined when no one in the mail matches or the
// mail cannot be read (the search then answers as if it had no fallback).
const searchMailHeaders = async (
  deps: Pick<SearchContactsDeps, 'emailHeadersMatching' | 'resolveMailAccountId'>,
  authorization: string,
  query: string
): Promise<MailPerson[] | undefined> => {
  try {
    const accountId = await deps.resolveMailAccountId(authorization)
    const messages = await deps.emailHeadersMatching({
      accountId,
      apiUrl: '',
      authorization,
      limit: MAIL_MESSAGES,
      query: withoutMy(query),
    })
    return peopleInMail(messages, query)
  } catch (err) {
    // No query or address in the log: they are the user's correspondents.
    logger.warn({ err }, 'search_contacts: the mail-header fallback failed')
    return undefined
  }
}

const mailResultText = (query: string, people: MailPerson[], total: number, capped: boolean): string => {
  const now = new Date()
  const blocks = people.map((p, i) => mailPersonBlock(p, now, i))
  const more =
    total > people.length
      ? `\n\nShowing ${people.length} of ${total} people found in mail: narrow the query (add a surname or part of the address) to disambiguate.`
      : ''
  return (
    `No contact matched "${query}" in any address book${capped ? '' : ', and no contact has it as a role'}. ` +
    `${people.length} person(s) found in the From, To and Cc of the newest matching messages in the mailbox, ` +
    'none of them saved as a contact:\n\n' +
    `${blocks.join('\n\n')}${more}\n\n` +
    (isRolePhrase(query)
      ? `None of them has "${withoutMy(query)}" as a role: they matched by name or address only. ${roleHint} `
      : '') +
    'Tell the user the address was found in their mail and is not saved as a contact. ' +
    'To save one, use create_contact (with `roles` when the user says what the person is to them).'
  )
}

// "my lawyer" is matched as "lawyer" everywhere, so a domain like
// `smithlawyer.example` still turns up, flagged by the note below.
const withoutMy = normalizeRole

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
  deps: ContactHydrationDeps,
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
  const roles = rolesLine(card)
  const birthday = birthdayLine(card)
  return [
    `${index + 1}. ${card.name?.full ?? best?.address ?? '(unnamed)'}`,
    // The handle create_contact/update_contact/delete_contact address the
    // record by — in the concise format too, so editing a contact never
    // costs an extra detailed round-trip.
    `   contact_id: ${card.id}`,
    ...(organization ? [`   organization: ${organization}`] : []),
    ...(roles ? [roles] : []),
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
  index: number,
  collectedBookId: string | undefined
): string => {
  const parts = [concisePerson(card, ext, args, hydrated, now, index)]
  const candidates = addressCandidates(card)
  if (candidates.length > 0) {
    parts.push('   addresses:')
    for (const c of candidates) {
      const preferred = c.preferred ? ', preferred' : ''
      const seen = c.lastSeen ? `, last seen ${relativeAge(c.lastSeen, now)}` : ''
      parts.push(`   - ${c.address} (${c.context}, ${c.confidence}${preferred}${seen})`)
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
  parts.push(`   source: ${sourceOf(card, collectedBookId)}`)
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

// What rendering one contact in the detailed format needs beyond the card:
// the subject and title lookups for its interaction lines.
const LIST_NUMBER = /^1\. /u

export type ContactHydrationDeps = Pick<SearchContactsDeps, 'emailGet' | 'fetchEventTitles' | 'resolveMailAccountId'>

// One contact in the detailed format, exactly as search_contacts prints it —
// what merge_contacts returns, so the agent checks a merge in the same shape
// it found the cards in.
export const renderDetailedContact = async (
  deps: ContactHydrationDeps,
  auth: { authorization: string; token: string },
  card: ContactCard,
  collectedBookId: string | undefined
): Promise<string> => {
  const ext = readCollected(card)
  const hydrated = await hydrate(deps, auth, ext.interactions)
  const args: SearchContactsArgs = { context: 'any', limit: 1, query: '', response_format: 'detailed' }
  // One contact, so no list number in front of it.
  return detailedPerson(card, ext, args, hydrated, new Date(), 0, collectedBookId).replace(LIST_NUMBER, '')
}

export const searchContacts = async (deps: SearchContactsDeps, ctx: SearchContactsContext): Promise<ToolResult> => {
  const { args, token } = ctx
  const query = args.query.trim()
  if (query.length === 0) {
    return errorResult('query must not be empty.')
  }
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)

  // Only the detailed format prints `source`, which needs the Collected
  // book's id.
  const detailed = args.response_format === 'detailed'
  const [sweep, books] = await Promise.all([
    sweepBook(deps, { accountId, authorization }, query),
    detailed ? deps.addressBookList({ accountId, apiUrl: '', authorization }) : Promise.resolve([]),
  ])
  const collectedBookId = books.find((b) => b.name === COLLECTED_BOOK_NAME)?.id
  const matched = await getInPages(deps, { accountId, authorization }, sweep.matched)
  const capNote = sweep.capped
    ? `\n\nOnly the first ${CARD_CAP} cards of the address books were searched; a contact past them may be missing.`
    : ''
  const mode = ctx.mode ?? 'hosted'
  if (matched.length === 0 && mode === 'self-hosted') {
    const people = await searchMailHeaders(deps, authorization, query)
    if (people && people.length > 0) {
      return textResult(`${mailResultText(query, people.slice(0, args.limit), people.length, sweep.capped)}${capNote}`)
    }
    return textResult(`${emptyResultText(query, sweep.capped, mode, people !== undefined)}${capNote}`)
  }
  if (matched.length === 0) {
    return textResult(`${emptyResultText(query, sweep.capped, mode)}${capNote}`)
  }

  // The people the user named this way come first: a role is the user's own
  // word for who they mean, which a name or domain hit ("Lawrence",
  // `lawhouse.example` for "lawyer") is not.
  const now = new Date()
  const roleHolders = matched.filter((c) => hasRole(c, query))
  const ranked = [
    ...rankCards(roleHolders, now),
    ...rankCards(
      matched.filter((c) => !hasRole(c, query)),
      now
    ),
  ]
  const page = ranked.slice(0, args.limit)

  const shown = args.response_format === 'detailed' ? undefined : SHOWN_INTERACTIONS
  const tuples = page.flatMap((card) => {
    const interactions = readCollected(card).interactions
    return shown === undefined ? interactions : interactions.slice(0, shown)
  })
  const hydrated = await hydrate(deps, { authorization, token }, tuples)

  const sections = page.map((card, i) =>
    detailed
      ? detailedPerson(card, readCollected(card), args, hydrated, now, i, collectedBookId)
      : concisePerson(card, readCollected(card), args, hydrated, now, i)
  )

  // Every match is counted, unless the sweep stopped at its cap.
  const atLeast = sweep.capped ? 'at least ' : ''
  const truncationNote =
    ranked.length > args.limit
      ? `\n\nShowing the top ${args.limit} of ${atLeast}${ranked.length} matches — narrow the query (add a surname, address fragment, or organization) to disambiguate.`
      : ''
  const relayNote = page.some((card) => (readCollected(card).relays?.length ?? 0) > 0)
    ? '\n\nNote: relay addresses (e.g. LinkedIn digests) were excluded as unusable; detailed format lists them.'
    : ''
  const noRoleNote =
    roleHolders.length === 0 && isRolePhrase(query)
      ? `\n\n${sweep.capped ? 'None of the people above has' : 'No contact has'} "${withoutMy(query)}" as a role: the people above matched by name, organization or address only. ${roleHint}`
      : ''
  return textResult(
    `${page.length} person(s) matched:\n\n${sections.join('\n\n')}${noRoleNote}${relayNote}${truncationNote}${capNote}`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive, caldav: CalDavConfig): SearchContactsDeps => ({
  addressBookList: async (p) => addressBookList({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  contactCardGet: async (p) => contactCardGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  contactCardPage: async (p) => contactCardPage({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailGet: async (p) => emailGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailHeadersMatching: async (p) =>
    emailHeadersMatching({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
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
  getToken: () => string,
  mode: ServerMode = 'hosted'
): void => {
  server.registerTool(
    'search_contacts',
    {
      annotations: READ_ONLY,
      description:
        "Resolve a person's name, partial name, email address, organization, or what " +
        'they are to the user ("my lawyer", "my landlord") to known contacts. People ' +
        (mode === 'hosted'
          ? 'holding that role come first, the rest are ranked by interaction recency and frequency. '
          : 'holding that role come first. ') +
        (mode === 'hosted'
          ? 'Sources ' +
            'include the collected address book maintained from mail headers (both ' +
            'directions, including Sent) and calendar attendees and organizers, plus ' +
            "the user's personal address books, and contacts written with " +
            'create_contact. '
          : "Sources are every address book in the user's account, including contacts written with create_contact, " +
            'plus, when no contact matches, the people in the From, To and Cc of the newest matching mail, ' +
            'returned marked as not saved as a contact. ') +
        'Use this before creating events or drafting mail when only ' +
        'a name is known, and before create_contact or update_contact to get the ' +
        'contact_id. Returns for each contact its roles, one or more addresses with a ' +
        'confidence level, the birthday when one is stored' +
        (mode === 'hosted' ? ', and recent interactions' : '') +
        '; the detailed format adds phone numbers, postal addresses ' +
        'and the note. Do not use it to enumerate all contacts; a query is ' +
        'required, and for "whose birthday is coming up" use ' +
        'list_upcoming_birthdays instead. If several plausible people match, ' +
        'present the candidates to the user rather than guessing; when two of them ' +
        'are the same person or organization, merge_contacts folds them into one.',
      inputSchema: z.object(searchContactsShape),
      title: 'Search contacts',
    },
    (args) => searchContacts(deps, { args: searchContactsInput.parse(args), mode, token: getToken() })
  )
}
