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
// Email and destroying the old one.
//
// The two halves are two round trips, deliberately, and not one Email/set with
// both a `create` and a `destroy`. `Foo/set` is explicitly not a transaction
// (RFC 8620 §5.3: each create/update/destroy is an independent atomic unit, a
// rejected one is reported under `notCreated`/`notDestroyed` and the server
// carries on) — so batching them means a create Stalwart refuses, for quota or
// any other reason, destroys the draft anyway and the user's staged message is
// gone from everywhere. Sequencing costs a round trip and a transient window in
// which both drafts exist; losing the content costs the content. `Email/set` has
// no `onSuccessDestroy`, so one call cannot express the dependency at all.

import { buildEmailSetPatch } from './patch.ts'
import { jmapCall as call, type JmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import { type EmailAddress, type EmailComposeRecord } from './types.ts'

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

// RFC 8621 §4.1.5 system keyword marking a message as an unsent draft. Clients
// (and Langmail's own UI) key "this is editable, not delivered" off it.
export const DRAFT_KEYWORD = '$draft'

// The prefix of the keyword that keeps a draft's id stable across edits. An
// edit writes a new Email (see the header), so the JMAP id changes every time;
// every revision carries `$draftid:<token>`, and a lookup by that keyword finds
// the current revision from the token the caller was first handed. A keyword
// rather than a header because Stalwart answers an Email/query `header`
// condition with nothing, while `hasKeyword` is indexed — and a keyword never
// leaves the mailbox, where a header would ride along on the sent mail.
export const DRAFT_ID_KEYWORD_PREFIX = '$draftid:'

// The prefix of the keyword a reply draft carries naming the message it
// answers, by JMAP id. The draft's In-Reply-To header names it too, but only by
// Message-ID, which Stalwart cannot query — and once an edit changes the
// subject, Stalwart files the replacement in a thread of its own, so the
// original is not even a thread sibling any more. update_draft reads this to
// re-quote the original below edited text.
export const DRAFT_REPLY_TO_KEYWORD_PREFIX = '$draftreplyto:'

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
  // The Date header — what a reply's "On …, X wrote:" line cites.
  'sentAt',
  'textBody',
  'htmlBody',
  'bodyValues',
  'attachments',
  'hasAttachment',
] as const

const COMPOSE_BODY_PROPERTIES = [
  'partId',
  'blobId',
  'name',
  'type',
  'size',
  'disposition',
  'cid',
  // Read so a rewrite can put it back — an HTML body may resolve an inline
  // resource through Content-Location rather than `cid:`.
  'location',
] as const

// One file hanging off a draft. Always a blob that already exists on the
// server: RFC 8621 §4.1.4 `attachments` is a list of EmailBodyPart references,
// so bytes are uploaded first (RFC 8620 §6.1 `uploadUrl` — `blobUpload` in
// blob.ts) and only the resulting handle reaches Email/set. That is also what
// makes re-attaching a file already in the mailbox free: its blobId is the same
// kind of handle, so a forward transfers nothing.
export interface DraftAttachment {
  blobId: string
  // Set only for an inline part an HTML body references as `cid:…`.
  cid?: string
  // RFC 8621 §4.1.4 `disposition` as the *stored* message has it. Carried
  // through a rewrite rather than re-derived, because the two are genuinely
  // independent: a plain attachment may well carry a Content-ID, and inferring
  // "has a cid, therefore inline" would turn a file the recipient was offered
  // as a download into one their client tries to render in the body. Absent for
  // a newly supplied file, where there is nothing to preserve and the cid is
  // the only signal available.
  disposition?: string
  // Content-Location, preserved for the same reason as `cid`: an HTML body may
  // resolve an inline resource through it, and a rewrite that dropped it would
  // leave the unchanged HTML pointing at nothing.
  location?: string
  name?: string
  // Read back off a stored draft so a caller can report what is attached.
  // Never sent — the server computes the part's size from the blob.
  size?: number
  type?: string
}

// The message a draft stages, in the shape the caller thinks in. `text` and
// `html` are the body content itself (not part references) — the wrapper turns
// them into the bodyValues/textBody/htmlBody triple the wire wants, and
// Stalwart assembles multipart/alternative when both are given.
export interface EmailDraft {
  attachments?: DraftAttachment[]
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
  // Extra keywords to carry onto the new message, alongside `$draft`/`$seen` —
  // the `$label:` tags an edited draft already had, so an edit doesn't untag it.
  keywords?: string[]
  // The account's Drafts mailbox — resolved by role, not name (see
  // `mailboxIdByNameOrRole`).
  mailboxId: string
  // Draft this one replaces. Destroyed only after the new one exists — see the
  // header. Omit for a fresh draft.
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
const draftProperties = (p: DraftCreateParams): Record<string, unknown> => {
  const draft = p.draft
  const bodyValues: Record<string, { value: string }> = {}
  const props: Record<string, unknown> = {
    from: draft.from,
    keywords: {
      [DRAFT_KEYWORD]: true,
      [SEEN_KEYWORD]: true,
      ...Object.fromEntries((p.keywords ?? []).map((keyword) => [keyword, true])),
    },
    mailboxIds: { [p.mailboxId]: true },
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
  // Omitted rather than sent as `{}` when the draft has no body at all —
  // reachable by editing a bodiless draft.
  if (Object.keys(bodyValues).length > 0) {
    props.bodyValues = bodyValues
  }
  if (draft.attachments && draft.attachments.length > 0) {
    props.attachments = draft.attachments.map(attachmentPart)
  }
  return props
}

// One EmailBodyPart reference, as Email/set wants it.
//
// `disposition` is set explicitly rather than left to the server: it is what
// decides whether a receiving client shows the part as a file to download or
// renders it in place, and RFC 8621 gives no default. A disposition read off a
// stored message wins, so an edit presents the file the way it was already
// presented; only a newly supplied attachment falls back to inferring it from
// the `cid`, which is then the only evidence there is. `size` is dropped — the
// server computes it from the blob, and it only exists on this type so a stored
// draft can be read back.
const attachmentPart = (attachment: DraftAttachment): Record<string, unknown> => ({
  blobId: attachment.blobId,
  disposition: attachment.disposition ?? (attachment.cid ? 'inline' : 'attachment'),
  type: attachment.type ?? 'application/octet-stream',
  ...(attachment.cid ? { cid: attachment.cid } : {}),
  ...(attachment.location ? { location: attachment.location } : {}),
  ...(attachment.name === undefined ? {} : { name: attachment.name }),
})

export interface DraftDestroyParams extends JmapCall {
  accountId: string
  id: string
}

// What became of one destroy: gone, or the RFC 8620 §5.3 SetError type the
// server refused it with (`notFound`, `forbidden`, …). A value rather than a
// throw, because both callers need the refusal: delete_draft reports it, the
// second half of an edit reports a leftover draft.
export type DraftDestroyResult = { destroyed: true } | { notDestroyed: string }

// Permanently destroy one draft — no Trash copy. The one Email/set destroy path
// on this surface: an edit retires the revision it replaces through it, and
// delete_draft retires a whole draft.
export const draftDestroy = async (p: DraftDestroyParams): Promise<DraftDestroyResult> => {
  const resp = await call(p, {
    methodCalls: [['Email/set', { accountId: p.accountId, destroy: [p.id] }, '0']],
    using: USING,
  })
  const out = methodResponse<{ destroyed?: string[]; notDestroyed?: Record<string, { type?: string }> }>(
    resp,
    'Email/set',
    '0'
  )
  if ((out.destroyed ?? []).includes(p.id)) {
    return { destroyed: true }
  }
  return { notDestroyed: out.notDestroyed?.[p.id]?.type ?? 'unknown' }
}

// The destroy half of an edit, with every failure folded into `false`. Once the
// replacement exists, throwing would discard its id — and the caller, told only
// that the edit failed, would retry against the old id and pile up more drafts.
// A leftover draft the caller is told about beats a lost id.
const destroyedQuietly = async (p: DraftDestroyParams): Promise<boolean> => {
  try {
    return 'destroyed' in (await draftDestroy(p))
  } catch {
    return false
  }
}

// Take the `$draftid:` keyword off a superseded draft the destroy left behind,
// so the draft id names exactly one message: the replacement. Left on, the two
// copies tie on `receivedAt` (one-second resolution) when an edit follows
// quickly, and `draftIdResolve` could pick the pre-edit one — even after the
// replacement was sent, delivering the old wording a second time. Keywords are
// the one thing RFC 8621 lets a client patch, so this can land where the
// destroy did not; if it fails as well, the caller's leftover note still names
// the stale copy.
const supersededQuietly = async (p: DraftCreateParams & { id: string }): Promise<void> => {
  const patch = buildEmailSetPatch({
    keywords: Object.fromEntries(
      (p.keywords ?? [])
        .filter((keyword) => keyword.startsWith(DRAFT_ID_KEYWORD_PREFIX))
        .map((keyword) => [keyword, false])
    ),
  })
  if (Object.keys(patch).length === 0) {
    return
  }
  try {
    await call(p, {
      methodCalls: [['Email/set', { accountId: p.accountId, update: { [p.id]: patch } }, '0']],
      using: USING,
    })
  } catch {
    // Reported through `replacedDestroyed: false` either way.
  }
}

// Stage a draft and return its id. When `replaces` is given, the superseded
// draft is destroyed only after the new one exists — see the header for why that
// is a second round trip and not one batched Email/set.
//
// Throws JmapError when Stalwart reports the create under `notCreated`; the
// draft being replaced is then untouched, so nothing has been lost.
export const draftCreate = async (p: DraftCreateParams): Promise<DraftCreateResult> => {
  const resp = await call(p, {
    methodCalls: [['Email/set', { accountId: p.accountId, create: { [CREATE_ID]: draftProperties(p) } }, '0']],
    using: USING,
  })
  const out = methodResponse<{
    created?: Record<string, { id?: string; threadId?: string }>
    notCreated?: Record<string, { description?: string; type?: string }>
  }>(resp, 'Email/set', '0')
  const created = out.created?.[CREATE_ID]
  if (!created?.id) {
    // `type` is a JMAP error code (`invalidProperties`, `overQuota`, …), not
    // free text, so it is safe to surface; the description can quote the
    // message the caller staged and stays out, as it does on submission.
    //
    // It is passed through as the error type rather than only interpolated so
    // callers can tell "the server refused this draft" from a transport
    // failure — an unresolvable attachment blobId lands here as
    // `invalidProperties`, and that is a mistake the caller can correct.
    const refusal = out.notCreated?.[CREATE_ID]
    throw new JmapError(200, `Email/set did not create the draft: ${refusal?.type ?? 'unknown'}`, refusal?.type)
  }
  if (!p.replaces) {
    return { id: created.id, threadId: created.threadId ?? null }
  }
  const replacedDestroyed = await destroyedQuietly({ ...p, id: p.replaces })
  if (!replacedDestroyed) {
    await supersededQuietly({ ...p, id: p.replaces })
  }
  return { id: created.id, replacedDestroyed, threadId: created.threadId ?? null }
}

export interface EmailComposeGetParams extends JmapCall {
  accountId: string
  // Which body values to fetch. `all` (the default) is every text/* part, text
  // attachments included — what a draft rewrite needs. `body` is only the parts
  // of textBody/htmlBody (RFC 8621 fetchTextBodyValues/fetchHTMLBodyValues):
  // all that quoting a message into a reply reads, without pulling a large
  // .csv attachment over the wire at the same budget.
  bodyValues?: 'all' | 'body'
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
          ...(p.bodyValues === 'body'
            ? { fetchHTMLBodyValues: true, fetchTextBodyValues: true }
            : { fetchAllBodyValues: true }),
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

// The mailbox/keyword patch that turns a sent draft into sent mail: `$draft`
// cleared, and out of Drafts into Sent. Exported for EmailSubmission's
// `onSuccessUpdateEmail`, which applies it server-side iff the send succeeds.
//
// Clearing `$draft` is unconditional, and that is the load-bearing half. It is
// what makes "this message is no longer a draft" the server-side record that a
// send already happened — the guard a second send call trips over. Only the
// mailbox move depends on the account having a Sent mailbox; skipping the whole
// patch when it doesn't would leave the message looking unsent forever, so a
// retried call would deliver it again.
//
// The `$draftid:` and `$draftreplyto:` keywords are deliberately left on. The
// draft id still naming the sent message is what turns a later send of the
// same draft id into "already sent" rather than "not found" — clearing it
// would leave that retry nothing to resolve and nothing to explain.
export const sentEmailPatch = (draftsMailboxId: string, sentMailboxId?: string): Record<string, boolean | null> =>
  buildEmailSetPatch({
    keywords: { [DRAFT_KEYWORD]: false },
    ...(sentMailboxId ? { mailboxIds: { [draftsMailboxId]: false, [sentMailboxId]: true } } : {}),
  })

export interface DraftIdResolveParams extends JmapCall {
  accountId: string
  // The stable draft id — the token every revision carries.
  draftId: string
}

// The current revision of the draft known as `draftId`, or null when no
// message carries its `$draftid:` keyword (it is a JMAP id, not a draft id).
// Newest first as a backstop: `draftCreate` takes the token off a superseded
// revision its destroy left behind, so only if that patch failed too can two
// messages answer to the token — and then the replacement wins.
export const draftIdResolve = async (p: DraftIdResolveParams): Promise<string | null> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'Email/query',
        {
          accountId: p.accountId,
          calculateTotal: false,
          filter: { hasKeyword: `${DRAFT_ID_KEYWORD_PREFIX}${p.draftId}` },
          limit: 1,
          sort: [{ isAscending: false, property: 'receivedAt' }],
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ ids?: string[] }>(resp, 'Email/query', '0')
  return out.ids?.[0] ?? null
}

export interface ThreadMessageFindParams extends JmapCall {
  accountId: string
  // Any message of the thread to search — the reply draft itself.
  emailId: string
  // RFC 8621 "asMessageIds" form: bare, without angle brackets.
  messageId: string
}

// The id of the message in `emailId`'s thread whose Message-ID is `messageId`,
// or null. This is how an edited reply finds the message it quotes: the draft
// keeps only the In-Reply-To header, and Stalwart cannot query by header, but
// it threads a reply onto its original — so the original is one of the
// thread's messages. One round trip: the draft's threadId, the thread, and the
// Message-ID of every message in it.
export const threadMessageFind = async (p: ThreadMessageFindParams): Promise<string | null> => {
  const resp = await call(p, {
    methodCalls: [
      ['Email/get', { accountId: p.accountId, ids: [p.emailId], properties: ['threadId'] }, '0'],
      [
        'Thread/get',
        { '#ids': { name: 'Email/get', path: '/list/*/threadId', resultOf: '0' }, accountId: p.accountId },
        '1',
      ],
      [
        'Email/get',
        {
          '#ids': { name: 'Thread/get', path: '/list/*/emailIds', resultOf: '1' },
          accountId: p.accountId,
          properties: ['id', 'messageId'],
        },
        '2',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{ list?: { id: string; messageId?: string[] | null }[] }>(resp, 'Email/get', '2')
  return out.list?.find((email) => email.messageId?.includes(p.messageId))?.id ?? null
}
