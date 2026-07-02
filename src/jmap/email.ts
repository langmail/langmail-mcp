// Typed JMAP wrappers for the Email, Thread, and Mailbox capabilities.
// Narrow on purpose — see services/mcp/AGENTS.md and spec/02 §Phase 2 for
// the "extract to packages/jmap/ only when a second service needs it" rule.

import { JmapError } from './session.ts'
import {
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
  token: string
}

const call = async <T extends JmapResponse>(ctx: JmapCall, body: JmapRequest): Promise<T> => {
  const res = await fetch(ctx.apiUrl, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${ctx.token}`,
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

export interface MailboxIdByNameParams extends JmapCall {
  accountId: string
  name: string
}

export const mailboxIdByName = async (p: MailboxIdByNameParams): Promise<string | null> => {
  // One round-trip: query all mailbox ids, hydrate names, match
  // case-insensitively. Stalwart's mailbox count is small enough that
  // skipping a name-filtered Mailbox/query (which JMAP doesn't directly
  // support anyway) is fine.
  const resp = await call(p, {
    methodCalls: [
      ['Mailbox/query', { accountId: p.accountId }, '0'],
      [
        'Mailbox/get',
        {
          '#ids': { name: 'Mailbox/query', path: '/ids', resultOf: '0' },
          accountId: p.accountId,
          properties: ['id', 'name'],
        },
        '1',
      ],
    ],
    using: USING,
  })
  const got = methodResponse<{ list?: MailboxRecord[] }>(resp, 'Mailbox/get', '1')
  const wanted = p.name.toLowerCase()
  const hit = (got.list ?? []).find((m) => m.name.toLowerCase() === wanted)
  return hit?.id ?? null
}
