// Typed JMAP wrappers for the Email, Thread, and Mailbox capabilities —
// the read surface (query/get/thread/mailbox lookup) plus the write and
// changes surface (Email/set patches, Email/changes, Mailbox/get by role)
// the email-agent needs once it becomes a JMAP client (ADR 0004).

import { jmapCall as call, type JmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import {
  type EmailChangesResult,
  type EmailDetailRecord,
  type EmailRecord,
  type MailboxRecord,
  type ThreadRecord,
} from './types.ts'

// Every JMAP request must declare the core capability alongside any it uses
// (RFC 8620 §3.3); Stalwart 0.16.10+ enforces this, rejecting requests whose
// `using` omits a required capability. Mirrors auth's StalwartAdminClient.
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

// Lightweight properties for search + thread listings. `keywords` is included
// so callers can surface a message's labels; `threadId` lets a hit expand.
const EMAIL_PROPERTIES = [
  'id',
  'subject',
  'from',
  'receivedAt',
  'preview',
  'mailboxIds',
  'keywords',
  'threadId',
  // Cheap boolean so list views can flag hits worth opening for their files.
  'hasAttachment',
  'attachments',
] as const

// Richer properties for get_email and the poller's analysis input:
// recipients, the text body parts, the RFC 5322 Message-ID list, and the
// raw-message blob handle (blobId/size) for langmail preprocessing.
const EMAIL_DETAIL_PROPERTIES = [
  'id',
  'blobId',
  'size',
  'subject',
  'from',
  'to',
  'cc',
  'receivedAt',
  'keywords',
  'messageId',
  'textBody',
  'bodyValues',
  'threadId',
  'attachments',
  'hasAttachment',
] as const

// Body-part properties requested alongside the detail fetch: enough to list
// attachments (name/type/size), classify cid-inline parts, and hand back the
// blobId retrieval handle — explicit so parts come back minimal.
const EMAIL_BODY_PROPERTIES = ['partId', 'blobId', 'name', 'type', 'size', 'disposition', 'cid'] as const

// Escape a keyword or mailbox id for use as an RFC 6901 JSON Pointer token in
// an Email/set PatchObject: `~` and `/` are structural and MUST be escaped
// (`~`→`~0`, `/`→`~1`), order matters (escape `~` first). Mirrors the Rust
// mirror in email-sync's `set_keywords`. Agent `$label:` keywords contain
// neither char, but keeping the escape correct means the same wrapper is safe
// for nested-label keywords too.
const jsonPointerEscape = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1')

// --- Email/query ---------------------------------------------------------

export interface EmailQueryFilters {
  after?: string
  before?: string
  from?: string
  // Full JMAP keyword strings, e.g. "$label:receipt". OR'd among themselves.
  keywords?: string[]
  mailboxId?: string
  // Free-text terms, OR'd among themselves. Each term is its own JMAP `text`
  // condition: Stalwart matches a multi-word `text` string only when every
  // token occurs in a single field, so passing a whole query as one condition
  // silently drops near-matches (e.g. a subject containing 2 of 3 words).
  text?: string[]
}

export interface EmailQueryParams extends JmapCall {
  accountId: string
  filters: EmailQueryFilters
  limit: number
}

// OR a set of conditions, collapsing a single element to its flat form —
// JMAP treats a bare condition and a one-element operator identically, but
// the flat form keeps the wire minimal.
const orNode = (conds: Record<string, unknown>[]): Record<string, unknown> | undefined =>
  conds.length === 1 ? conds[0] : { conditions: conds, operator: 'OR' }

// Compose the JMAP filter: text terms OR'd among themselves, keyword
// conditions OR'd among themselves, then both AND'd with the scalar
// conditions (date/from/mailbox). A single overall condition is passed
// through flat, like the OR nodes.
const buildFilter = (f: EmailQueryFilters): Record<string, unknown> => {
  const conditions: Record<string, unknown>[] = []
  if (f.text && f.text.length > 0) {
    const node = orNode(f.text.map((t) => ({ text: t })))
    if (node) {
      conditions.push(node)
    }
  }
  if (f.after) {
    conditions.push({ after: f.after })
  }
  if (f.before) {
    conditions.push({ before: f.before })
  }
  if (f.from) {
    conditions.push({ from: f.from })
  }
  if (f.mailboxId) {
    conditions.push({ inMailbox: f.mailboxId })
  }
  if (f.keywords && f.keywords.length > 0) {
    const node = orNode(f.keywords.map((k) => ({ hasKeyword: k })))
    if (node) {
      conditions.push(node)
    }
  }
  const [only] = conditions
  if (conditions.length === 1 && only) {
    return only
  }
  return { conditions, operator: 'AND' }
}

// --- Email/query (typed filter tree) ---------------------------------------

// One JMAP FilterCondition (RFC 8621 §4.4.1), narrowed to the fields the
// mail-rules engine translates rule conditions into. Every string field is a
// server-side substring/text match.
export interface EmailFilterCondition {
  body?: string
  from?: string
  hasAttachment?: boolean
  inMailbox?: string
  subject?: string
  text?: string
  to?: string
}

// A filter tree: a bare condition, or an AND/OR over subtrees. Mirrors the
// RFC 8621 FilterOperator shape 1:1 so it serializes directly.
export type EmailFilter = EmailFilterCondition | { conditions: EmailFilter[]; operator: 'AND' | 'OR' }

export interface EmailQueryFilterParams extends JmapCall {
  accountId: string
  // RFC 8621 §4.4: one result per thread instead of per message — the cheap
  // way to count matching conversations without fetching thread objects.
  collapseThreads?: boolean
  filter: EmailFilter
  limit: number
}

// Email/query with a caller-built filter tree — for callers whose condition
// logic (AND/OR composition) outgrows the flat `EmailQueryFilters` bag.
export const emailQueryFilter = async (p: EmailQueryFilterParams): Promise<string[]> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/query',
        {
          accountId: p.accountId,
          calculateTotal: false,
          ...(p.collapseThreads ? { collapseThreads: true } : {}),
          filter: p.filter,
          limit: p.limit,
          sort: [{ isAscending: false, property: 'receivedAt' }],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ ids?: string[] }>(resp, 'Email/query', '0')
  return out.ids ?? []
}

export interface EmailQueryPerTermParams extends JmapCall {
  accountId: string
  // Scalar filters applied to every term's query; `text` is ignored here —
  // each term becomes its own query.
  filters: EmailQueryFilters
  limit: number
  terms: string[]
}

// One Email/query per term, batched into a single JMAP request. JMAP has no
// relevance sort, so a caller that wants match-count ranking ("messages
// hitting more terms first") needs to know which terms matched which
// messages — an OR query collapses that information. Each per-term filter
// ANDs the term with the scalar filters; each list is newest-first.
export const emailQueryPerTerm = async (p: EmailQueryPerTermParams): Promise<string[][]> => {
  const resp = await call(p, {
    methodCalls: p.terms.map((term, i) => [
      'Email/query',
      {
        accountId: p.accountId,
        calculateTotal: false,
        filter: buildFilter({ ...p.filters, text: [term] }),
        limit: p.limit,
        sort: [{ isAscending: false, property: 'receivedAt' }],
      },
      String(i),
    ]),
    using: USING,
  })
  return p.terms.map((_, i) => methodResponse<{ ids?: string[] }>(resp, 'Email/query', String(i)).ids ?? [])
}

export const emailQuery = async (p: EmailQueryParams): Promise<string[]> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/query',
        {
          accountId: p.accountId,
          // Stalwart FTS full totals are expensive on a big mailbox and we
          // don't show them.
          calculateTotal: false,
          filter: buildFilter(p.filters),
          limit: p.limit,
          // Newest-first: "last N months" questions need recency, and the
          // default mailbox order is meaningless for a date-scoped query.
          sort: [{ isAscending: false, property: 'receivedAt' }],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ ids?: string[] }>(resp, 'Email/query', '0')
  return out.ids ?? []
}

// --- Email/get (lightweight) ---------------------------------------------

export interface EmailGetParams extends JmapCall {
  accountId: string
  ids: string[]
}

export const emailGet = async (p: EmailGetParams): Promise<EmailRecord[]> => {
  if (p.ids.length === 0) {
    return []
  }
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/get',
        {
          accountId: p.accountId,
          bodyProperties: [...EMAIL_BODY_PROPERTIES],
          ids: p.ids,
          properties: [...EMAIL_PROPERTIES],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: EmailRecord[] }>(resp, 'Email/get', '0')
  return out.list ?? []
}

// --- Email/get (detail, with body) ---------------------------------------

export interface EmailGetDetailParams extends JmapCall {
  accountId: string
  ids: string[]
  maxBodyValueBytes: number
}

export const emailGetDetail = async (p: EmailGetDetailParams): Promise<EmailDetailRecord[]> => {
  if (p.ids.length === 0) {
    return []
  }
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/get',
        {
          accountId: p.accountId,
          bodyProperties: [...EMAIL_BODY_PROPERTIES],
          // Populate bodyValues for the text parts, capped so a huge message
          // can't blow the token budget (Stalwart truncates at this size).
          fetchTextBodyValues: true,
          ids: p.ids,
          maxBodyValueBytes: p.maxBodyValueBytes,
          properties: [...EMAIL_DETAIL_PROPERTIES],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: EmailDetailRecord[] }>(resp, 'Email/get', '0')
  return out.list ?? []
}

// --- Email/set (patch) ---------------------------------------------------

// Targeted membership changes for one email: `true` adds, `false` removes. Keys
// are the full JMAP keyword string (`$label:receipt`) or the mailbox id; both
// are JSON-pointer-escaped before hitting the wire. The two maps translate onto
// the wire differently (see `buildSetPatch`): keyword removal follows
// email-sync's production-proven `false` convention, mailbox removal follows the
// RFC 8620 canonical `null`.
export interface EmailSetChanges {
  keywords?: Record<string, boolean>
  mailboxIds?: Record<string, boolean>
}

export interface EmailSetParams extends JmapCall {
  accountId: string
  changes: EmailSetChanges
  id: string
}

const buildSetPatch = (changes: EmailSetChanges): Record<string, boolean | null> => {
  const patch: Record<string, boolean | null> = {}
  // Keywords: boolean value, `false` removes. This mirrors email-sync's Rust
  // `set_keywords` byte-for-byte and is production-proven against Stalwart
  // (read-state + label mirroring both drive the `false`=remove path).
  for (const [keyword, value] of Object.entries(changes.keywords ?? {})) {
    patch[`keywords/${jsonPointerEscape(keyword)}`] = value
  }
  // MailboxIds: `true` adds, `null` removes. RFC 8621 requires mailboxIds map
  // values be `true`, so removal uses the RFC 8620 canonical PatchObject `null`
  // rather than `false` — and unlike keywords there's no proven `false`-removal
  // precedent for mailboxes (Rust only ever replaces the set wholesale).
  for (const [mailboxId, value] of Object.entries(changes.mailboxIds ?? {})) {
    patch[`mailboxIds/${jsonPointerEscape(mailboxId)}`] = value ? true : null
  }
  return patch
}

// Patch keywords and/or mailbox membership on a single email via an Email/set
// `update` with a JSON-pointer PatchObject, leaving every other keyword and
// mailbox untouched — this is what lets sync's mirror and the agent's writes
// compose without clobbering each other (ADR 0004). Throws JmapError if
// Stalwart reports the id under `notUpdated` (or omits it from `updated`).
export const emailSet = async (p: EmailSetParams): Promise<void> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/set',
        {
          accountId: p.accountId,
          update: { [p.id]: buildSetPatch(p.changes) },
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{
    notUpdated?: Record<string, { description?: string; type?: string }>
    updated?: Record<string, unknown>
  }>(resp, 'Email/set', '0')
  if (out.updated && p.id in out.updated) {
    return
  }
  const reason = out.notUpdated?.[p.id]
  throw new JmapError(200, `Email/set did not update ${p.id}: ${reason?.type ?? 'unknown'}`)
}

// --- Email/set (bulk patch) ------------------------------------------------

export interface EmailSetManyParams extends JmapCall {
  accountId: string
  // One uniform patch applied to every id — what a mail rule's backfill does.
  changes: EmailSetChanges
  ids: string[]
}

export interface EmailSetManyResult {
  notUpdated: string[]
  updated: string[]
}

// Apply the same PatchObject to many emails in a single Email/set. Partial
// failure is data, not an exception: the caller (rule backfill) reports
// modified/failed counts instead of aborting on the first bad id.
export const emailSetMany = async (p: EmailSetManyParams): Promise<EmailSetManyResult> => {
  if (p.ids.length === 0) {
    return { notUpdated: [], updated: [] }
  }
  const patch = buildSetPatch(p.changes)
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/set',
        {
          accountId: p.accountId,
          update: Object.fromEntries(p.ids.map((id) => [id, patch])),
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{
    notUpdated?: Record<string, { type?: string }>
    updated?: Record<string, unknown>
  }>(resp, 'Email/set', '0')
  const updated = new Set(Object.keys(out.updated ?? {}))
  return {
    notUpdated: p.ids.filter((id) => !updated.has(id)),
    updated: p.ids.filter((id) => updated.has(id)),
  }
}

// --- Email state ----------------------------------------------------------

export interface EmailStateParams extends JmapCall {
  accountId: string
}

// The account's current Email state string (RFC 8621 §5), fetched via an
// empty Email/get. The poller seeds a fresh cursor from this so only mail
// arriving after the seed gets analyzed — no historical backfill.
export const emailState = async (p: EmailStateParams): Promise<string> => {
  const resp = await call(p, {
    methodCalls: [['Email/get', { accountId: p.accountId, ids: [] }, '0']],
    using: USING,
  })
  const out = methodResponse<{ state?: string }>(resp, 'Email/get', '0')
  if (!out.state) {
    throw new JmapError(200, 'Email/get returned no state')
  }
  return out.state
}

// --- Email/changes -------------------------------------------------------

export interface EmailChangesParams extends JmapCall {
  accountId: string
  // Cap the delta so a large backlog pages instead of returning unbounded
  // ids; the caller loops on `hasMoreChanges` from `newState`.
  maxChanges?: number
  sinceState: string
}

// The delta of email ids created/updated/destroyed since `sinceState`
// (RFC 8621 §5.2). The poller persists `newState` as its cursor and only
// advances it once the batch is processed — a failed batch replays.
export const emailChanges = async (p: EmailChangesParams): Promise<EmailChangesResult> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/changes',
        {
          accountId: p.accountId,
          ...(p.maxChanges === undefined ? {} : { maxChanges: p.maxChanges }),
          sinceState: p.sinceState,
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<Partial<EmailChangesResult>>(resp, 'Email/changes', '0')
  return {
    created: out.created ?? [],
    destroyed: out.destroyed ?? [],
    hasMoreChanges: out.hasMoreChanges ?? false,
    newState: out.newState ?? p.sinceState,
    oldState: out.oldState ?? p.sinceState,
    updated: out.updated ?? [],
  }
}

// --- Thread/get ----------------------------------------------------------

export interface ThreadEmailIdsParams extends JmapCall {
  accountId: string
  emailId: string
}

// Resolve every message id in the same thread as `emailId`, oldest-first
// (RFC 8621 §3 requires Thread.emailIds sorted by receivedAt ascending).
// One round-trip: Email/get the threadId, then Thread/get via a result ref.
export const threadEmailIds = async (p: ThreadEmailIdsParams): Promise<string[]> => {
  const resp = await call(p, {
    methodCalls: [
      ['Email/get', { accountId: p.accountId, ids: [p.emailId], properties: ['threadId'] }, '0'],
      [
        'Thread/get',
        {
          '#ids': { name: 'Email/get', path: '/list/*/threadId', resultOf: '0' },
          accountId: p.accountId,
        },
        '1',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: ThreadRecord[] }>(resp, 'Thread/get', '1')
  const [thread] = out.list ?? []
  return thread?.emailIds ?? []
}

export interface ThreadExpandParams extends JmapCall {
  accountId: string
  emailIds: string[]
}

// Expand a set of message ids to every message in their threads (deduped,
// input-thread order). One round-trip via a Thread/get back-reference — the
// bulk sibling of `threadEmailIds`, for the rules backfill's
// "matching conversations" mode.
export const threadsExpandEmailIds = async (p: ThreadExpandParams): Promise<string[]> => {
  if (p.emailIds.length === 0) {
    return []
  }
  const resp = await call(p, {
    methodCalls: [
      ['Email/get', { accountId: p.accountId, ids: p.emailIds, properties: ['threadId'] }, '0'],
      [
        'Thread/get',
        {
          '#ids': { name: 'Email/get', path: '/list/*/threadId', resultOf: '0' },
          accountId: p.accountId,
        },
        '1',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: ThreadRecord[] }>(resp, 'Thread/get', '1')
  const ids = new Set<string>()
  for (const thread of out.list ?? []) {
    for (const id of thread.emailIds) {
      ids.add(id)
    }
  }
  return [...ids]
}

// --- Mailbox/get ---------------------------------------------------------

// One round-trip that hydrates every mailbox's id + name + role. Stalwart's
// mailbox count is small, so listing all and matching in memory is cheaper
// than the name/role-filtered Mailbox/query JMAP doesn't directly support.
const fetchMailboxes = async (p: JmapCall & { accountId: string }): Promise<MailboxRecord[]> => {
  const resp = await call(p, {
    methodCalls: [
      ['Mailbox/query', { accountId: p.accountId }, '0'],
      [
        'Mailbox/get',
        {
          '#ids': { name: 'Mailbox/query', path: '/ids', resultOf: '0' },
          accountId: p.accountId,
          properties: ['id', 'name', 'role'],
        },
        '1',
      ],
    ],
    using: USING,
  })
  const got = methodResponse<{ list?: MailboxRecord[] }>(resp, 'Mailbox/get', '1')
  return got.list ?? []
}

export interface MailboxIdByNameParams extends JmapCall {
  accountId: string
  name: string
}

export const mailboxIdByName = async (p: MailboxIdByNameParams): Promise<string | null> => {
  const wanted = p.name.toLowerCase()
  const hit = (await fetchMailboxes(p)).find((m) => m.name.toLowerCase() === wanted)
  return hit?.id ?? null
}

export interface MailboxIdByRoleParams extends JmapCall {
  accountId: string
  // RFC 8621 special-use role, e.g. "inbox", "archive", "sent".
  role: string
}

// Resolve a mailbox by its special-use role — the stable way to find the
// inbox for auto-archive, independent of the localized display name.
export const mailboxIdByRole = async (p: MailboxIdByRoleParams): Promise<string | null> => {
  const wanted = p.role.toLowerCase()
  const hit = (await fetchMailboxes(p)).find((m) => m.role?.toLowerCase() === wanted)
  return hit?.id ?? null
}

// The RFC 8621 special-use role behind each *place* name the product speaks.
//
// A place is addressed by name everywhere a human or an agent types one
// ("Sent", "Archive"), but the mailbox actually holding that mail is whatever
// carries the role — and its display name is the server's to choose. A stock
// Stalwart account names its sent mailbox **"Sent Items"**, so a name-only
// lookup for "Sent" misses the very folder the Gmail projection files sent mail
// into (`services/email-sync` `ensure_place_mailbox` binds by role, not name).
// That miss reads to the caller as "sent mail was never synced".
//
// Keys are lowercase; synonyms map onto the same role so the obvious spelling
// works ("Spam" → junk, "Bin" → trash).
const ROLE_BY_PLACE_NAME: Record<string, string> = {
  archive: 'archive',
  bin: 'trash',
  drafts: 'drafts',
  inbox: 'inbox',
  junk: 'junk',
  sent: 'sent',
  spam: 'junk',
  trash: 'trash',
}

// The special-use role a place name refers to, or `undefined` for a name that
// isn't a place (an ordinary user folder, resolvable by name only).
export const roleForPlaceName = (name: string): string | undefined => ROLE_BY_PLACE_NAME[name.trim().toLowerCase()]

// Resolve a caller-supplied folder name to a mailbox id: exact (case-folded)
// name first, then — for a place name — the mailbox carrying that role.
//
// Name wins deliberately. The input is an arbitrary string a user or agent
// typed, so a folder literally called "Archive" is what they meant even when
// some other mailbox holds the `archive` role; the role is the fallback that
// keeps "Sent" resolving on a server that calls it "Sent Items". (The Rust
// projection inverts this — it only ever emits places, so role-first is right
// there.) One round-trip serves both lookups.
export const mailboxIdByNameOrRole = async (p: MailboxIdByNameParams): Promise<string | null> => {
  const mailboxes = await fetchMailboxes(p)
  const wanted = p.name.trim().toLowerCase()
  const byName = mailboxes.find((m) => m.name.toLowerCase() === wanted)
  if (byName) {
    return byName.id
  }
  const role = roleForPlaceName(p.name)
  return role ? (mailboxes.find((m) => m.role?.toLowerCase() === role)?.id ?? null) : null
}

// Every folder name in the account. Used to turn a failed mailbox lookup into
// an actionable error rather than a dead end.
export const mailboxNames = async (p: JmapCall & { accountId: string }): Promise<string[]> =>
  (await fetchMailboxes(p)).map((m) => m.name)

export interface MailboxIdsByRolesParams extends JmapCall {
  accountId: string
  roles: string[]
}

// Resolve several special-use roles from one mailbox listing — the archive
// move needs both inbox and archive, and one round-trip beats two.
export const mailboxIdsByRoles = async (p: MailboxIdsByRolesParams): Promise<Record<string, string | null>> => {
  const mailboxes = await fetchMailboxes(p)
  return Object.fromEntries(
    p.roles.map((role) => {
      const wanted = role.toLowerCase()
      return [role, mailboxes.find((m) => m.role?.toLowerCase() === wanted)?.id ?? null]
    })
  )
}

// --- Mailbox/set (create) --------------------------------------------------

export interface MailboxCreateParams extends JmapCall {
  accountId: string
  name: string
  // RFC 8621 special-use role, e.g. "archive".
  role?: string
}

// Create a mailbox and return its id. The agent uses this to ensure an
// Archive mailbox exists before an auto-archive move — RFC 8621 requires
// every email to stay in at least one mailbox, so archiving is add-Archive +
// remove-Inbox rather than a bare removal.
export const mailboxCreate = async (p: MailboxCreateParams): Promise<string> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Mailbox/set',
        {
          accountId: p.accountId,
          create: { m0: { name: p.name, ...(p.role === undefined ? {} : { role: p.role }) } },
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{
    created?: Record<string, { id?: string }>
    notCreated?: Record<string, { description?: string; type?: string }>
  }>(resp, 'Mailbox/set', '0')
  const id = out.created?.m0?.id
  if (!id) {
    throw new JmapError(200, `Mailbox/set did not create ${p.name}: ${out.notCreated?.m0?.type ?? 'unknown'}`)
  }
  return id
}
