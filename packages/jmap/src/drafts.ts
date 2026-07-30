// Typed JMAP wrappers for composition: Email/set `create` to stage a draft, and
// Email/get with the composition-relevant properties — every recipient field
// plus the threading headers and both body parts.
//
// That read serves two callers, which is why it isn't named for drafts: reading
// a staged draft back so it can be edited, and reading the message being replied
// to so the reply's recipients and threading can be derived from it.
//
// Editing a draft is create-then-destroy, not an update. RFC 8621 §4.6 makes
// every Email property except `keywords` and `mailboxIds` immutable — a
// message's content is its blob — so "change the subject" means writing a new
// Email and destroying the old one. Both halves ride in a single Email/set,
// which RFC 8620 §5.3 orders create-before-destroy, so an edit is never
// visible as two drafts and never loses the old one on a failed create.

import { buildEmailSetPatch } from './patch.ts'
import { jmapCall as call, type JmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import { type EmailAddress, type EmailComposeRecord } from './types.ts'

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

// RFC 8621 §4.1.5 system keyword marking a message as an unsent draft. Clients
// (and Langmail's own UI) key "this is editable, not delivered" off it.
export const DRAFT_KEYWORD = '$draft'

// A draft the user composed is not unread mail — Stalwart would otherwise
// count it towards the Drafts folder's unread badge.
const SEEN_KEYWORD = '$seen'

// Client-chosen creation ids. Only ever one create and one destroy per call,
// so fixed ids are enough and keep the response lookup readable.
const CREATE_ID = 'draft'

// partIds are client-supplied on create (RFC 8621 §4.6) and only have to be
// unique within the message — they name the bodyValues entry each body part
// pulls its content from.
const TEXT_PART_ID = 'text'
const HTML_PART_ID = 'html'

// Everything composition needs off a message: recipients (bcc included, which
// only a draft has), the threading headers, and both body part lists.
const COMPOSE_PROPERTIES = [
  'id',
  'blobId',
  'size',
  'threadId',
  'mailboxIds',
  'keywords',
  'subject',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'messageId',
  'inReplyTo',
  'references',
  'receivedAt',
  'textBody',
  'htmlBody',
  'bodyValues',
  'attachments',
  'hasAttachment',
] as const

const COMPOSE_BODY_PROPERTIES = ['partId', 'blobId', 'name', 'type', 'size', 'disposition', 'cid'] as const

// The message a draft stages, in the shape the caller thinks in. `text` and
// `html` are the body content itself (not part references) — the wrapper turns
// them into the bodyValues/textBody/htmlBody triple the wire wants, and
// Stalwart assembles multipart/alternative when both are given.
export interface EmailDraft {
  bcc?: EmailAddress[]
  cc?: EmailAddress[]
  from: EmailAddress[]
  html?: string
  // RFC 8621 "asMessageIds" form: bare Message-IDs without angle brackets.
  inReplyTo?: string[]
  references?: string[]
  replyTo?: EmailAddress[]
  subject?: string
  text?: string
  to?: EmailAddress[]
}

export interface DraftCreateParams extends JmapCall {
  accountId: string
  draft: EmailDraft
  // The account's Drafts mailbox — resolved by role, not name (see
  // `mailboxIdByNameOrRole`).
  mailboxId: string
  // Draft this one replaces, destroyed in the same Email/set. Omit for a fresh
  // draft.
  replaces?: string
}

export interface DraftCreateResult {
  id: string
  // Whether the `replaces` draft was actually destroyed. `undefined` when no
  // replacement was requested. A `false` here means the edit landed but the
  // superseded draft is still in the folder — worth telling the caller about
  // rather than swallowing, since they'd see two drafts.
  replacedDestroyed?: boolean
  threadId: string | null
}

// Translate the caller's draft into the Email/set `create` object. Only the
// properties the caller actually set are emitted: JMAP distinguishes an absent
// property from an explicitly null one, and sending `cc: null` on a create is
// noise at best.
const draftProperties = (draft: EmailDraft, mailboxId: string): Record<string, unknown> => {
  const bodyValues: Record<string, { value: string }> = {}
  const props: Record<string, unknown> = {
    from: draft.from,
    keywords: { [DRAFT_KEYWORD]: true, [SEEN_KEYWORD]: true },
    mailboxIds: { [mailboxId]: true },
  }
  // Empty recipient lists are omitted, not sent as `[]`: every draft is written
  // by a create (an edit included — see the header), so "no cc" and "cc
  // cleared" are the same message, and the absent property is the canonical
  // spelling of it.
  for (const [field, addresses] of [
    ['to', draft.to],
    ['cc', draft.cc],
    ['bcc', draft.bcc],
    ['replyTo', draft.replyTo],
  ] as const) {
    if (addresses && addresses.length > 0) {
      props[field] = addresses
    }
  }
  if (draft.subject !== undefined) {
    props.subject = draft.subject
  }
  if (draft.inReplyTo && draft.inReplyTo.length > 0) {
    props.inReplyTo = draft.inReplyTo
  }
  if (draft.references && draft.references.length > 0) {
    props.references = draft.references
  }
  if (draft.text !== undefined) {
    bodyValues[TEXT_PART_ID] = { value: draft.text }
    props.textBody = [{ partId: TEXT_PART_ID, type: 'text/plain' }]
  }
  if (draft.html !== undefined) {
    bodyValues[HTML_PART_ID] = { value: draft.html }
    props.htmlBody = [{ partId: HTML_PART_ID, type: 'text/html' }]
  }
  props.bodyValues = bodyValues
  return props
}

// Stage a draft (optionally replacing an existing one) and return its id.
// Throws JmapError when Stalwart reports the create under `notCreated`.
export const draftCreate = async (p: DraftCreateParams): Promise<DraftCreateResult> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/set',
        {
          accountId: p.accountId,
          create: { [CREATE_ID]: draftProperties(p.draft, p.mailboxId) },
          ...(p.replaces ? { destroy: [p.replaces] } : {}),
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{
    created?: Record<string, { id?: string; threadId?: string }>
    destroyed?: string[]
    notCreated?: Record<string, { description?: string; type?: string }>
  }>(resp, 'Email/set', '0')
  const created = out.created?.[CREATE_ID]
  if (!created?.id) {
    throw new JmapError(200, `Email/set did not create the draft: ${out.notCreated?.[CREATE_ID]?.type ?? 'unknown'}`)
  }
  return {
    id: created.id,
    threadId: created.threadId ?? null,
    ...(p.replaces ? { replacedDestroyed: (out.destroyed ?? []).includes(p.replaces) } : {}),
  }
}

export interface EmailComposeGetParams extends JmapCall {
  accountId: string
  id: string
  maxBodyValueBytes: number
}

// Read one message with the composition-relevant properties: a staged draft to
// edit, or the message a reply is being derived from. Returns null when the id
// doesn't exist — a destroyed or unknown id is a caller-visible condition, not
// an exception.
export const emailComposeGet = async (p: EmailComposeGetParams): Promise<EmailComposeRecord | null> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/get',
        {
          accountId: p.accountId,
          bodyProperties: [...COMPOSE_BODY_PROPERTIES],
          // Both parts, not just text: an html-only draft would otherwise read
          // back with an empty body.
          fetchAllBodyValues: true,
          ids: [p.id],
          maxBodyValueBytes: p.maxBodyValueBytes,
          properties: [...COMPOSE_PROPERTIES],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: EmailComposeRecord[] }>(resp, 'Email/get', '0')
  return out.list?.[0] ?? null
}

// The mailbox/keyword patch that turns a sent draft into sent mail: out of
// Drafts, into Sent, `$draft` cleared. Exported for EmailSubmission's
// `onSuccessUpdateEmail`, which applies it server-side iff the send succeeds.
export const sentEmailPatch = (draftsMailboxId: string, sentMailboxId: string): Record<string, boolean | null> =>
  buildEmailSetPatch({
    keywords: { [DRAFT_KEYWORD]: false },
    mailboxIds: { [draftsMailboxId]: false, [sentMailboxId]: true },
  })
