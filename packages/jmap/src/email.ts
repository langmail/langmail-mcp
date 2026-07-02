// Typed JMAP wrappers for the Email, Thread, and Mailbox capabilities —
// the read surface (query/get/thread/mailbox lookup) plus the write and
// changes surface (Email/set patches, Email/changes, Mailbox/get by role)
// the email-agent needs once it becomes a JMAP client (ADR 0004).

import { JmapError } from './session.ts'
import {
  type EmailChangesResult,
  type EmailDetailRecord,
  type EmailRecord,
  type JmapRequest,
  type JmapResponse,
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
] as const

// Richer properties for get_email: recipients plus the text body parts.
const EMAIL_DETAIL_PROPERTIES = [
  'id',
  'subject',
  'from',
  'to',
  'cc',
  'receivedAt',
  'keywords',
  'textBody',
  'bodyValues',
] as const

interface JmapCall {
  apiUrl: string
  // Full Authorization header value (`Bearer …` or `Basic …`) — the wrappers
  // never mint or wrap credentials. MCP builds it via `bearerAuthorization`;
  // the email-agent forwards the `Basic` value the auth service's
  // stalwart-credential endpoint returns.
  authorization: string
}

const call = async <T extends JmapResponse>(ctx: JmapCall, body: JmapRequest): Promise<T> => {
  const res = await fetch(ctx.apiUrl, {
    body: JSON.stringify(body),
    headers: {
      authorization: ctx.authorization,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap request returned ${res.status}`)
  }
  return (await res.json()) as T
}

const methodResponse = <T>(resp: JmapResponse, name: string, callId: string): T => {
  const entry = resp.methodResponses.find(([n, , id]) => n === name && id === callId)
  if (!entry) {
    throw new JmapError(200, `missing method response for ${name}/${callId}`)
  }
  return entry[1] as T
}

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
  text?: string
}

export interface EmailQueryParams extends JmapCall {
  accountId: string
  filters: EmailQueryFilters
  limit: number
}

// Compose the JMAP filter: keyword conditions OR'd among themselves, then
// AND'd with the scalar conditions (text/date/from/mailbox). A single overall
// condition is passed through flat — JMAP treats a bare condition and a
// one-element AND identically, but the flat form keeps the wire minimal.
const buildFilter = (f: EmailQueryFilters): Record<string, unknown> => {
  const conditions: Record<string, unknown>[] = []
  if (f.text) {
    conditions.push({ text: f.text })
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
    const kw = f.keywords.map((k) => ({ hasKeyword: k }))
    const node = kw.length === 1 ? kw[0] : { conditions: kw, operator: 'OR' }
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
