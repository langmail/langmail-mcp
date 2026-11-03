// Typed JMAP wrappers for the Email, Thread, and Mailbox capabilities —
// the read surface (query/get/thread/mailbox lookup) plus the write and
// changes surface (Email/set patches, Email/changes, Mailbox/get by role)
// the email-agent needs once it becomes a JMAP client (ADR 0004).

import { buildEmailSetPatch, type EmailSetChanges } from './patch.ts'
import { jmapCall as call, type JmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import {
  type EmailChangesResult,
  type EmailDetailRecord,
  type EmailRecord,
  type EmailUnsubscribeRecord,
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
// recipients, the text body parts, the RFC 5322 Message-ID list, the
// raw-message blob handle (blobId/size) for langmail preprocessing, and
// mailboxIds so the poller can tell sent mail by its Sent membership.
const EMAIL_DETAIL_PROPERTIES = [
  'id',
  'blobId',
  'size',
  'subject',
  'from',
  'to',
  'cc',
  'receivedAt',
  'mailboxIds',
  'keywords',
  'messageId',
  'textBody',
  // Part metadata only (no values fetched here) — the blobId handle lets a
  // caller download the full HTML part without a truncation cap.
  'htmlBody',
  'bodyValues',
  'threadId',
  'attachments',
  'hasAttachment',
] as const

// Body-part properties requested alongside the detail fetch: enough to list
// attachments (name/type/size), classify cid-inline parts, and hand back the
// blobId retrieval handle — explicit so parts come back minimal.
const EMAIL_BODY_PROPERTIES = ['partId', 'blobId', 'name', 'type', 'size', 'disposition', 'cid'] as const

// The keyword/mailbox PatchObject shape is shared with EmailSubmission's
// `onSuccessUpdateEmail` (see patch.ts) and re-exported here so the Email/set
// callers keep importing it from the capability they're using.
export type { EmailSetChanges } from './patch.ts'

// --- Email/query ---------------------------------------------------------

export interface EmailQueryFilters {
  after?: string
  before?: string
  from?: string
  // Full JMAP keyword strings mapped to whether a message must carry them,
  // e.g. { $seen: false } for unread. AND'd with everything else.
  keywordStates?: Record<string, boolean>
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
// conditions (date/from/mailbox/keyword states). A single overall condition is passed
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
  for (const [keyword, present] of Object.entries(f.keywordStates ?? {})) {
    conditions.push(present ? { hasKeyword: keyword } : { notKeyword: keyword })
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
          // Stalwart FTS full totals are expensive on a big mailbox; callers
          // that need one ask `emailQueryTotal` once a page comes back full.
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

export interface EmailQueryTotalParams extends JmapCall {
  accountId: string
  filters: EmailQueryFilters
}

// How many messages match the filters in total, regardless of any page limit.
// Text terms are OR'd exactly as in `emailQuery`, so a multi-term search's
// total counts the union of its per-term hits. Totals cost a full FTS count on
// Stalwart, so callers ask only when a page came back full.
export const emailQueryTotal = async (p: EmailQueryTotalParams): Promise<number> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/query',
        {
          accountId: p.accountId,
          calculateTotal: true,
          filter: buildFilter(p.filters),
          // `limit: 0` is spec-legal (RFC 8620 §5.5 types it UnsignedInt) but
          // servers disagree on whether it means "none" or "no limit"; ask for
          // one id and discard it. Only `total` is wanted here.
          limit: 1,
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ total?: number }>(resp, 'Email/query', '0')
  if (out.total === undefined) {
    throw new Error('Email/query returned no total despite calculateTotal')
  }
  return out.total
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

// --- Email/get (headers only) ----------------------------------------------

// What contact collection reads off a message: addressing headers, keywords
// (skip-filter), mailboxIds (Sent detection), receivedAt. No bodies — the
// backfill pages thousands of messages and must stay cheap.
const EMAIL_HEADER_PROPERTIES = ['id', 'from', 'to', 'cc', 'receivedAt', 'keywords', 'mailboxIds'] as const

export interface EmailGetHeadersParams extends JmapCall {
  accountId: string
  ids: string[]
}

export const emailGetHeaders = async (p: EmailGetHeadersParams): Promise<EmailDetailRecord[]> => {
  if (p.ids.length === 0) {
    return []
  }
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/get',
        {
          accountId: p.accountId,
          ids: p.ids,
          properties: [...EMAIL_HEADER_PROPERTIES],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: EmailDetailRecord[] }>(resp, 'Email/get', '0')
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

// --- Email/get (unsubscribe headers) -------------------------------------

// The list headers in the forms RFC 8621 §4.1.2 defines: List-Unsubscribe
// Raw (folding kept, the caller parses `<uri>` entries itself), the Post and
// Delivered-To headers as unfolded text. The text body is fetched so a
// message without the header can still point at its footer link.
const EMAIL_UNSUBSCRIBE_PROPERTIES = [
  'id',
  'mailboxIds',
  'keywords',
  'to',
  'textBody',
  'bodyValues',
  'header:List-Unsubscribe',
  'header:List-Unsubscribe-Post:asText',
  'header:Delivered-To:asText:all',
] as const

export interface EmailGetUnsubscribeParams extends JmapCall {
  accountId: string
  id: string
  maxBodyValueBytes: number
}

export const emailGetUnsubscribe = async (p: EmailGetUnsubscribeParams): Promise<EmailUnsubscribeRecord | null> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/get',
        {
          accountId: p.accountId,
          bodyProperties: ['partId', 'type'],
          fetchTextBodyValues: true,
          ids: [p.id],
          maxBodyValueBytes: p.maxBodyValueBytes,
          properties: [...EMAIL_UNSUBSCRIBE_PROPERTIES],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: EmailUnsubscribeRecord[] }>(resp, 'Email/get', '0')
  return out.list?.[0] ?? null
}

// --- Email/set (patch) ---------------------------------------------------

export interface EmailSetParams extends JmapCall {
  accountId: string
  changes: EmailSetChanges
  id: string
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
          update: { [p.id]: buildEmailSetPatch(p.changes) },
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

// One id the server refused, with the SetError type it gave (RFC 8620 §5.3),
// or `unknown` when the id was simply absent from both maps. The type is what
// lets a caller distinguish "this message was deleted" (`notFound`) from a
// failure it must not paper over — the keyword backfill skips the former and
// aborts on the latter rather than reporting a completed run over messages it
// never labeled.
export interface EmailSetError {
  id: string
  type: string
}

export interface EmailSetManyResult {
  notUpdated: EmailSetError[]
  updated: string[]
}

// Apply the same PatchObject to many emails in a single Email/set. Partial
// failure is data, not an exception: the caller (rule backfill) reports
// modified/failed counts instead of aborting on the first bad id.
export const emailSetMany = async (p: EmailSetManyParams): Promise<EmailSetManyResult> => {
  if (p.ids.length === 0) {
    return { notUpdated: [], updated: [] }
  }
  const patch = buildEmailSetPatch(p.changes)
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
  return setManyOutcome(p.ids, methodResponse<EmailSetManyResponse>(resp, 'Email/set', '0'))
}

interface EmailSetManyResponse {
  notUpdated?: Record<string, { type?: string }>
  updated?: Record<string, unknown>
}

// Fold an Email/set response over the ids we asked for: every id is reported
// exactly once, as updated or as refused with the server's SetError type.
const setManyOutcome = (ids: string[], out: EmailSetManyResponse): EmailSetManyResult => {
  const updated = new Set(Object.keys(out.updated ?? {}))
  return {
    notUpdated: ids
      .filter((id) => !updated.has(id))
      .map((id) => ({ id, type: out.notUpdated?.[id]?.type ?? 'unknown' })),
    updated: ids.filter((id) => updated.has(id)),
  }
}

// --- Email/set (bulk mailbox replacement) ---------------------------------

export interface EmailSetMailboxesParams extends JmapCall {
  accountId: string
  ids: string[]
  mailboxId: string
}

// Replace every email's mailbox membership with exactly one mailbox — a
// "move" in the sense every JMAP client means it. Sends the whole
// `mailboxIds` property rather than a `mailboxIds/<id>` pointer patch: the
// patch form (`emailSetMany`) can only add or drop the mailboxes it names,
// so it cannot express "and remove it from everywhere else". Same
// partial-failure contract as emailSetMany.
export const emailSetMailboxes = async (p: EmailSetMailboxesParams): Promise<EmailSetManyResult> => {
  if (p.ids.length === 0) {
    return { notUpdated: [], updated: [] }
  }
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/set',
        {
          accountId: p.accountId,
          update: Object.fromEntries(p.ids.map((id) => [id, { mailboxIds: { [p.mailboxId]: true } }])),
        },
        '0',
      ],
    ],
    using: USING,
  })
  return setManyOutcome(p.ids, methodResponse<EmailSetManyResponse>(resp, 'Email/set', '0'))
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
// inbox, independent of the localized display name.
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

// Resolve a caller-supplied folder name to a mailbox id: for a *place* name the
// mailbox carrying that role, else (and as the fallback) an exact, case-folded
// name match. One round-trip serves both lookups.
//
// Role wins for the eight place names because the role *is* what identifies a
// place — the same rule `services/email-sync` `ensure_place_mailbox` projects
// under, so both halves of the system agree on what "Sent" means. Name-first
// would be shadowable: a stray role-less folder literally named "Sent" (the
// mail-rules `resolveMailboxByName` used to create exactly that) would swallow
// the lookup and return zero hits instead of the account's real sent mail —
// reproducing the very symptom this resolver exists to fix, and silently.
//
// Name remains the fallback, so an ordinary user folder resolves as it always
// did, and a place name still works on a server that has no mailbox carrying
// that role but does have one named for it.
export const mailboxIdByNameOrRole = async (p: MailboxIdByNameParams): Promise<string | null> => {
  const mailboxes = await fetchMailboxes(p)
  const role = roleForPlaceName(p.name)
  const byRole = role ? mailboxes.find((m) => m.role?.toLowerCase() === role) : undefined
  if (byRole) {
    return byRole.id
  }
  const wanted = p.name.trim().toLowerCase()
  return mailboxes.find((m) => m.name.toLowerCase() === wanted)?.id ?? null
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

// Create a mailbox (optionally with a special-use role) and return its id.
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
