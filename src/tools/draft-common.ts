// Shared plumbing for the composition tools (create_draft, get_draft,
// list_drafts, update_draft, send_draft, delete_draft, reply_to_message).
//
// Three things live here because getting them wrong in one tool and right in
// another is exactly the failure the sending surface can't afford:
//
//   - address parsing, so `Name <address>` — the form search_contacts hands
//     back — is accepted everywhere a recipient is accepted;
//   - identity resolution, so the sending address is always one the account is
//     actually allowed to send as;
//   - reply derivation (recipients, `Re:` subject, In-Reply-To/References), so
//     threading is computed server-side from the message being replied to and
//     never assembled by the agent.

import {
  accountIdForMail,
  accountIdForSubmission,
  type BlobUploadParams,
  blobUpload,
  DRAFT_FORWARD_OF_KEYWORD_PREFIX,
  DRAFT_ID_KEYWORD_PREFIX,
  DRAFT_KEYWORD,
  DRAFT_REPLY_TO_KEYWORD_PREFIX,
  type DraftAttachment,
  type DraftCreateParams,
  type DraftCreateResult,
  type DraftDestroyParams,
  type DraftDestroyResult,
  type DraftIdResolveParams,
  type DraftListParams,
  type DraftListResult,
  draftCreate,
  draftDestroy,
  draftIdResolve,
  draftList,
  type EmailAddress,
  type EmailComposeGetParams,
  type EmailComposeRecord,
  type EmailDraft,
  type EmailSetParams,
  type EmailSubmissionCreateParams,
  type EmailSubmissionResult,
  emailComposeGet,
  emailSet,
  emailSubmissionCreate,
  type IdentityGetParams,
  type IdentityRecord,
  identityGet,
  JmapError,
  type JmapLive,
  LABEL_KEYWORD_PREFIX,
  mailboxIdsByRoles,
  type ThreadMessageFindParams,
  threadMessageFind,
} from '../jmap/index.ts'
import { formatAddressList, formatSize } from './format.ts'
import { htmlToText } from './html-to-text.ts'

// The read-back budget for a draft's body values, in *octets* (RFC 8621 §4.2) —
// four times the 100_000-*character* cap the composition tools accept, because a
// character can cost up to four octets in UTF-8.
//
// The multiplier is the whole point. At 1× a perfectly legal draft of 100_000
// characters containing anything non-ASCII — an em dash, an accented name, an
// emoji — reads back truncated, and update_draft would re-stage the truncated
// text and destroy the original: a subject-only edit would silently amputate the
// message. Headroom makes that unreachable for any body this surface accepted;
// `bodyTruncated` catches a body some other client staged.
export const MAX_DRAFT_BODY_VALUE_BYTES = 400_000

// Enough of the body for a human to recognise what was staged without paying
// for the whole thing twice (the agent wrote it — it already has the text).
const BODY_PREVIEW_CHARS = 500

// The mailboxes composition needs, resolved by RFC 8621 special-use role
// rather than name: a stock Stalwart account calls them "Drafts" and
// "Sent Items", and a name lookup for "Sent" misses the second one. Trash is
// here because trash_emails can still discard a draft (delete_draft is the
// clean way), and the `$draft` keyword survives the move.
export interface ComposeMailboxes {
  drafts: string | null
  sent: string | null
  trash: string | null
}

export interface DraftToolDeps {
  // Stages attachment bytes as a blob so `Email/set` can reference the handle —
  // see drafts/attachments.ts for why bytes never reach Email/set directly.
  blobUpload: (p: BlobUploadParams) => Promise<string>
  draftCreate: (p: DraftCreateParams) => Promise<DraftCreateResult>
  draftDestroy: (p: DraftDestroyParams) => Promise<DraftDestroyResult>
  // The current revision of an edited draft, by its stable id — see
  // `loadDraft`.
  draftIdResolve: (p: DraftIdResolveParams) => Promise<string | null>
  draftList: (p: DraftListParams) => Promise<DraftListResult>
  emailComposeGet: (p: EmailComposeGetParams) => Promise<EmailComposeRecord | null>
  // Patch keywords on one message — how a forwarded original gets `$forwarded`.
  emailKeywordsSet: (p: EmailSetParams) => Promise<void>
  emailSubmissionCreate: (p: EmailSubmissionCreateParams) => Promise<EmailSubmissionResult>
  identityGet: (p: IdentityGetParams) => Promise<IdentityRecord[]>
  resolveAccountId: (authorization: string) => Promise<string>
  resolveComposeMailboxes: (authorization: string) => Promise<ComposeMailboxes>
  // Identities and submissions hang off the submission capability's account,
  // which Stalwart co-locates with mail but the session resource may name
  // separately.
  resolveSubmissionAccountId: (authorization: string) => Promise<string>
  // The message a reply draft answers, found in the draft's own thread.
  threadMessageFind: (p: ThreadMessageFindParams) => Promise<string | null>
}

// --- addresses -------------------------------------------------------------

// `Display Name <local@domain>`. The name is whatever precedes the bracketed
// address, quotes and all — anchoring on the brackets rather than on a quoting
// convention means a nickname (`Nadia "Nads" Bram <n@example.org>`) parses
// instead of being bounced back at the caller.
const NAMED_ADDRESS_RE = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/u

// Surrounding quotes on a display name are RFC 5322 syntax, not part of the
// name.
const WRAPPING_QUOTES_RE = /^"(.*)"$/u

// Deliberately permissive: one `@`, no whitespace or angle brackets, something
// either side. Stalwart is the authority on deliverability, and a stricter
// regex here would reject valid addresses (RFC 5322 local parts are wild)
// without making an invalid one any less rejected downstream.
const BARE_ADDRESS_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u

// Parse one recipient in either the bare or `Name <address>` form. Returns null
// for anything that isn't an address — the caller reports it by name rather
// than silently dropping a recipient the user asked for.
export const parseAddress = (input: string): EmailAddress | null => {
  const named = NAMED_ADDRESS_RE.exec(input)
  if (named) {
    const address = named[2] ?? ''
    if (!BARE_ADDRESS_RE.test(address)) {
      return null
    }
    const raw = (named[1] ?? '').trim()
    const name = (WRAPPING_QUOTES_RE.exec(raw)?.[1] ?? raw).trim()
    return name ? { email: address, name } : { email: address }
  }
  const bare = input.trim()
  return BARE_ADDRESS_RE.test(bare) ? { email: bare } : null
}

interface AddressListParse {
  addresses: EmailAddress[]
  invalid: string[]
}

const parseAddressList = (values: string[] | undefined): AddressListParse => {
  const addresses: EmailAddress[] = []
  const invalid: string[] = []
  for (const value of values ?? []) {
    const parsed = parseAddress(value)
    if (parsed) {
      addresses.push(parsed)
    } else {
      invalid.push(value)
    }
  }
  return { addresses, invalid }
}

// Every recipient field parsed in one pass, so a malformed address in `cc` is
// reported alongside one in `to` instead of one call at a time.
export interface RecipientFields {
  bcc?: string[]
  cc?: string[]
  to?: string[]
}

export interface ParsedRecipients {
  bcc?: EmailAddress[]
  cc?: EmailAddress[]
  to?: EmailAddress[]
}

// How many people a message is addressed to, across all three fields. Counting
// beats "was `to` supplied", because `to: []` is present but empty and addresses
// nobody. Deliberately blind to the element type so the staging check (raw
// strings from the caller) and the send check (parsed addresses off the record)
// cannot drift apart — they already did once, which is why this is shared.
export const countRecipients = (fields: {
  bcc?: unknown[] | null
  cc?: unknown[] | null
  to?: unknown[] | null
}): number => (fields.to?.length ?? 0) + (fields.cc?.length ?? 0) + (fields.bcc?.length ?? 0)

export const parseRecipients = (fields: RecipientFields): { error: string } | ParsedRecipients => {
  const to = parseAddressList(fields.to)
  const cc = parseAddressList(fields.cc)
  const bcc = parseAddressList(fields.bcc)
  const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid]
  if (invalid.length > 0) {
    return {
      error:
        `Not a valid email address: ${invalid.join(', ')}. ` +
        'Pass a bare address (person@example.com) or the "Name <person@example.com>" form.',
    }
  }
  // Deduped for the same reason the derived reply recipients are: the same
  // person twice on one line is a visible oddity in the recipient's client, and
  // an agent that resolved a contact twice shouldn't produce it.
  return {
    ...(fields.to ? { to: dedupeAddresses(to.addresses, []) } : {}),
    ...(fields.cc ? { cc: dedupeAddresses(cc.addresses, []) } : {}),
    ...(fields.bcc ? { bcc: dedupeAddresses(bcc.addresses, []) } : {}),
  }
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Drop duplicates (case-insensitively on the address) and anything already
// spoken for, keeping first-seen order.
const dedupeAddresses = (addresses: EmailAddress[], exclude: string[]): EmailAddress[] => {
  const seen = new Set(exclude.map((e) => e.toLowerCase()))
  const out: EmailAddress[] = []
  for (const address of addresses) {
    const key = address.email.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(address)
    }
  }
  return out
}

// --- sending identity ------------------------------------------------------

export interface ResolvedIdentity {
  address: EmailAddress
  identityId: string
  // Every address this account can send as, plus the authenticated principal —
  // i.e. every address that is "the user". A reply must exclude all of them, not
  // just the one it happens to be going out as, or an alias the original was
  // addressed to ends up receiving the user's own reply.
  selfAddresses: string[]
}

export interface IdentityResolution {
  accountId: string
  authorization: string
  // Caller-supplied sending address, bare or `Name <address>`. Omitted means
  // the authenticated account's own address.
  from?: string
  principal: string
}

// The account's configured display name wins over one the caller typed: it's
// what the user's other mail goes out as, and a draft that reads differently
// from the rest of their Sent folder is the tell that an agent wrote it.
//
// On Stalwart that name is the account's `description`, falling back to its
// `name` (the local part). Provisioning (services/auth `createIndividual`) sets
// the description to the user's display name, so the Identity is the account's
// one record of its sender name and no tool that sends has to patch it up.
const identityAddress = (identity: IdentityRecord, requestedName?: string): EmailAddress => {
  const name = identity.name?.trim() || requestedName
  return name ? { email: identity.email, name } : { email: identity.email }
}

// Pick the Identity a message goes out as. `from` selects among the account's
// aliases and is rejected if it names an address the account may not send as —
// that check has to be server-side, because an agent has no way to know which
// aliases exist and a silently-substituted sender is worse than an error.
export const resolveIdentity = async (
  deps: DraftToolDeps,
  p: IdentityResolution
): Promise<{ error: string } | ResolvedIdentity> => {
  const identities = await deps.identityGet({
    accountId: p.accountId,
    apiUrl: '',
    authorization: p.authorization,
  })
  if (identities.length === 0) {
    return { error: 'This account has no sending identity configured, so nothing can be composed or sent.' }
  }
  const selfAddresses = [p.principal, ...identities.map((identity) => identity.email)]

  let wanted = p.principal
  let requestedName: string | undefined
  if (p.from !== undefined) {
    const parsed = parseAddress(p.from)
    if (!parsed) {
      return { error: `Not a valid sending address: ${p.from}.` }
    }
    wanted = parsed.email
    requestedName = parsed.name ?? undefined
  }

  const hit = identities.find((identity) => sameAddress(identity.email, wanted))
  if (!hit) {
    if (p.from !== undefined) {
      return {
        error:
          `This account cannot send as ${wanted}. Available sending addresses: ` +
          `${identities.map((identity) => identity.email).join(', ')}.`,
      }
    }
    // The principal isn't among the identities — an aliased login, say. With a
    // single identity there is only one address this account could possibly
    // send as, so use it. With several, picking one would be a guess at which
    // of the user's addresses they meant, and Identity/get guarantees no
    // ordering to make that guess with — so ask instead of silently choosing.
    const [only] = identities
    if (identities.length > 1 || !only) {
      return {
        error:
          `Could not tell which address to send as: the signed-in address is not one of this account's ` +
          `sending identities. Pass \`from\` with one of: ${identities.map((i) => i.email).join(', ')}.`,
      }
    }
    return { address: identityAddress(only), identityId: only.id, selfAddresses }
  }
  return { address: identityAddress(hit, requestedName), identityId: hit.id, selfAddresses }
}

// --- replies ---------------------------------------------------------------

// The reply's recipients, derived from the message being answered. `Reply-To`
// wins over `From` when the sender set it (RFC 5322 §3.6.2 — that's what it's
// for); reply-all folds the original To and Cc into Cc.
//
// `self` is every address that is the user (see `ResolvedIdentity.selfAddresses`)
// and all of them are excluded, not just the sending one: a message addressed to
// one of the user's aliases would otherwise put that alias on the reply's Cc,
// delivering the user their own reply — and, once mail rules or an auto-responder
// exist on that alias, doing it in a loop.
export const replyRecipients = (
  original: EmailComposeRecord,
  self: string[],
  replyAll: boolean
): { cc: EmailAddress[]; to: EmailAddress[] } => {
  const replyTo = original.replyTo ?? []
  const to = dedupeAddresses(replyTo.length > 0 ? replyTo : (original.from ?? []), self)
  if (!replyAll) {
    return { cc: [], to }
  }
  const others = [...(original.to ?? []), ...(original.cc ?? [])]
  return { cc: dedupeAddresses(others, [...self, ...to.map((a) => a.email)]), to }
}

const RE_PREFIX_RE = /^re\s*:/iu

export const replySubject = (subject?: string | null): string => {
  const trimmed = (subject ?? '').trim()
  if (!trimmed) {
    return 'Re:'
  }
  return RE_PREFIX_RE.test(trimmed) ? trimmed : `Re: ${trimmed}`
}

// The RFC 5322 threading headers, in RFC 8621's bare-Message-ID form. Built
// from the original's own headers so a reply lands in the same conversation in
// every client, not just in Langmail's own threading.
export const replyThreading = (original: EmailComposeRecord): { inReplyTo: string[]; references: string[] } => {
  const messageIds = original.messageId ?? []
  const references = [...(original.references ?? []), ...messageIds]
  return {
    inReplyTo: messageIds,
    references: [...new Set(references)],
  }
}

// The one rule both reply paths enforce, in one place so they cannot disagree
// about it: `replyAll` and explicit recipients are mutually exclusive.
//
// "Reply to everyone, but only these people" has no defensible reading, and
// resolving it silently is worse than refusing. Per-field precedence looks
// harmless and isn't: with `replyAll` plus an explicit `to`, the derived Cc
// excludes the *derived* To, so the person actually being answered lands in
// neither list and the reply goes only to the bystanders. With `replyAll` plus
// an explicit `cc`, `replyAll` becomes a silent no-op.
export const replyConflictError = (p: {
  bcc?: unknown
  cc?: unknown
  replyAll?: boolean
  to?: unknown
}): string | null => {
  if (p.replyAll !== true) {
    return null
  }
  if (p.to !== undefined || p.cc !== undefined || p.bcc !== undefined) {
    return (
      'replyAll cannot be combined with to/cc/bcc. Either reply to everyone on the original, or name the ' +
      'recipients explicitly — not both.'
    )
  }
  return null
}

// --- draft round-tripping --------------------------------------------------

// Concatenate the fetched values of the body parts of one media type. Filtering
// on `type` matters: RFC 8621's `textBody` falls back to the text/html part on
// an html-only message, and reading that back as `text` would turn a staged
// html draft into a plain-text draft full of markup on the next edit.
const bodyOfType = (
  record: EmailComposeRecord,
  parts: EmailComposeRecord['textBody'],
  mediaType: string
): string | undefined => {
  const values = record.bodyValues ?? {}
  const matching = (parts ?? []).filter((part) => part.type === mediaType)
  if (matching.length === 0) {
    return
  }
  // Not trimmed: this value is re-staged verbatim by update_draft, and trimming
  // would silently edit a body the caller didn't touch.
  return matching.map((part) => (part.partId ? (values[part.partId]?.value ?? '') : '')).join('\n')
}

// Whether any body value came back truncated. A truncated read is fine to
// *display* and unsafe to *re-stage*, so this is the signal update_draft refuses
// on rather than quietly shortening the user's message.
// Scoped to the parts that actually make up the body, because `bodyValues` holds
// more than those: the read asks for `fetchAllBodyValues`, and RFC 8621 §4.2.2
// defines that as every text/* part in the structure — a .csv or .txt
// *attachment* included. Those come back truncated at the same budget, and a
// truncated attachment is not a truncated body: its bytes are re-referenced by
// blobId on a rewrite, never re-staged from this text, so nothing is at risk.
// Checking them too refused perfectly lossless edits with a diagnosis about the
// body — including an `attachments: []` that meant to remove the very file
// causing it. Unreachable before this surface could edit an attached draft at
// all, which is why it surfaces now.
export const bodyTruncated = (record: EmailComposeRecord): boolean => {
  const bodyPartIds = new Set(
    [...(record.textBody ?? []), ...(record.htmlBody ?? [])].flatMap((part) => (part.partId ? [part.partId] : []))
  )
  return Object.entries(record.bodyValues ?? {}).some(
    ([partId, value]) => value.isTruncated === true && bodyPartIds.has(partId)
  )
}

// The attached files of a stored draft, in the shape a re-create can reference.
//
// Only the blobId is carried, never the bytes: an edit rewrites the message, and
// re-referencing the existing blobs is what lets it do so without downloading
// and re-uploading a 5 MB PDF the caller never even mentioned. Parts with no
// blobId are dropped — an EmailBodyPart without one names nothing that can be
// re-attached — which is why `unreferencableAttachments` exists to stop an edit
// before that drop can become a silent loss.
//
// RFC 8621 lists most files under `attachments`, but an image inline in a
// `multipart/mixed` body — the shape Apple Mail sends, and the one a staged
// forward that carries such an image reads back as — sits in `textBody`/
// `htmlBody` between the text parts. Those are files too, so they are carried
// as well, inline as they were presented; a part listed in both body lists
// counts once.
export const attachmentsFromRecord = (record: EmailComposeRecord): DraftAttachment[] => {
  const inBody = [...(record.textBody ?? []), ...(record.htmlBody ?? [])]
    .filter((part) => part.type && !part.type.startsWith('text/'))
    .map((part) => ({ ...part, disposition: part.disposition ?? 'inline' }))
  const seen = new Set<string>()
  return [...(record.attachments ?? []), ...inBody].flatMap((part) => {
    const key = part.partId ?? part.blobId
    if (!part.blobId || (key && seen.has(key))) {
      return []
    }
    if (key) {
      seen.add(key)
    }
    return [
      {
        blobId: part.blobId,
        ...(part.cid ? { cid: part.cid } : {}),
        // Preserved, not re-derived — see DraftAttachment.disposition.
        ...(part.disposition ? { disposition: part.disposition } : {}),
        ...(part.location ? { location: part.location } : {}),
        ...(part.name ? { name: part.name } : {}),
        ...(typeof part.size === 'number' ? { size: part.size } : {}),
        ...(part.type ? { type: part.type } : {}),
      },
    ]
  })
}

// The attached files of a stored draft that could *not* be carried onto a
// replacement, named for a refusal message.
//
// RFC 8621 lets an EmailBodyPart's `blobId` be null (it is, for a multipart
// part), and a part without one cannot be re-referenced by the new message. An
// edit that quietly skipped it would destroy the original after writing a
// replacement missing the file — unrecoverable, and reported as a success.
// Refusing costs the caller an edit; the alternative costs them the file.
export const unreferencableAttachments = (record: EmailComposeRecord): string[] =>
  (record.attachments ?? []).filter((part) => !part.blobId).map((part) => part.name ?? '(unnamed)')

// Read a stored draft back into the composable shape, so update_draft can merge
// changes onto it and re-create the message (RFC 8621 makes an Email's content
// immutable — see src/jmap drafts.ts).
export const draftFromRecord = (record: EmailComposeRecord): EmailDraft => {
  const text = bodyOfType(record, record.textBody, 'text/plain')
  const html = bodyOfType(record, record.htmlBody, 'text/html')
  const attachments = attachmentsFromRecord(record)
  return {
    from: record.from ?? [],
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(record.to ? { to: record.to } : {}),
    ...(record.cc ? { cc: record.cc } : {}),
    ...(record.bcc ? { bcc: record.bcc } : {}),
    ...(record.replyTo ? { replyTo: record.replyTo } : {}),
    ...(record.subject === null || record.subject === undefined ? {} : { subject: record.subject }),
    ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}),
    ...(record.references ? { references: record.references } : {}),
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
  }
}

export const isDraft = (record: EmailComposeRecord): boolean => Boolean(record.keywords?.[DRAFT_KEYWORD])

// A draft moved to Trash still carries `$draft`, so `isDraft` alone would read,
// edit or send one the user has already discarded.
export const isTrashed = (record: EmailComposeRecord, mailboxes: ComposeMailboxes): boolean =>
  mailboxes.trash !== null && Boolean(record.mailboxIds?.[mailboxes.trash])

// How to get a discarded draft back, for the refusals that meet one.
export const restoreFromTrashHint = (record: EmailComposeRecord): string =>
  `To restore it, move it back with move_emails, passing id ${record.id} and mailbox "Drafts".`

// --- stable draft ids --------------------------------------------------------

const keywordSuffix = (record: EmailComposeRecord, prefix: string): string | null => {
  const keyword = Object.keys(record.keywords ?? {}).find((k) => k.startsWith(prefix))
  return keyword ? keyword.slice(prefix.length) : null
}

// The id a draft is known by on this surface: a random token create_draft mints
// and every revision carries as a `$draftid:` keyword (see src/jmap
// drafts.ts). A token, not the first revision's JMAP id: Stalwart may hand a
// freed id out again, and a stale keyword naming it would then resolve another
// draft's id to this one. Null for a draft staged by another client, which gets
// its token on its first edit and until then is known by its JMAP id. This is
// what create_draft, update_draft and get_draft report, so the id an agent
// holds keeps working across any number of edits.
export const stableDraftId = (record: EmailComposeRecord): string | null =>
  keywordSuffix(record, DRAFT_ID_KEYWORD_PREFIX)

// The keyword a revision carries so `loadDraft` can find it by its stable id.
export const stableDraftIdKeyword = (draftId: string): string => `${DRAFT_ID_KEYWORD_PREFIX}${draftId}`

// The keyword create_draft puts on a reply, naming the message it answers — see
// src/jmap drafts.ts for why the In-Reply-To header is not enough.
export const replyOriginalKeyword = (originalId: string): string => `${DRAFT_REPLY_TO_KEYWORD_PREFIX}${originalId}`

// The JMAP id of the message a reply draft answers, when create_draft recorded it.
export const replyOriginalId = (record: EmailComposeRecord): string | null =>
  keywordSuffix(record, DRAFT_REPLY_TO_KEYWORD_PREFIX)

// The keyword a staged forward carries, naming the message it forwards — see
// src/jmap drafts.ts.
export const forwardOriginalKeyword = (originalId: string): string => `${DRAFT_FORWARD_OF_KEYWORD_PREFIX}${originalId}`

// The JMAP id of the message a forward draft forwards, when it was staged here.
export const forwardOriginalId = (record: EmailComposeRecord): string | null =>
  keywordSuffix(record, DRAFT_FORWARD_OF_KEYWORD_PREFIX)

// RFC 5788 / RFC 8621 §4.1.1: the message has been forwarded. Clients show it
// next to the message, the way `$answered` marks a reply.
const FORWARDED_KEYWORD = '$forwarded'

// Mark the original of a forward that has gone out. Run once the send has
// succeeded, and never thrown from: the mail is already delivered, so a failure
// here is a line in the result, not a failed send. Returns that line, or null.
export const markForwarded = async (
  deps: DraftToolDeps,
  p: { accountId: string; authorization: string; id: string }
): Promise<string | null> => {
  try {
    await deps.emailKeywordsSet({
      accountId: p.accountId,
      apiUrl: '',
      authorization: p.authorization,
      changes: { keywords: { [FORWARDED_KEYWORD]: true } },
      id: p.id,
    })
    return null
  } catch {
    return `The forward went out, but the original (${p.id}) could not be marked as forwarded.`
  }
}

// RFC 8620 §1.2 Id syntax. Anything else cannot be a draft id, and spliced into
// a keyword it could make the query itself invalid.
const JMAP_ID_RE = /^[\w-]{1,255}$/u

// Read a draft by the id the caller holds: its stable id, or the JMAP id of
// any message (a draft found through search_emails, say). The keyword lookup
// runs first, because a stable id may still name a message — the first
// revision, when an edit created its replacement but failed to destroy it — and
// that superseded copy must never be what is read, edited, or sent.
export const loadDraft = async (
  deps: DraftToolDeps,
  p: { accountId: string; authorization: string; draftId: string }
): Promise<EmailComposeRecord | null> => {
  const current = JMAP_ID_RE.test(p.draftId)
    ? await deps.draftIdResolve({
        accountId: p.accountId,
        apiUrl: '',
        authorization: p.authorization,
        draftId: p.draftId,
      })
    : null
  return deps.emailComposeGet({
    accountId: p.accountId,
    apiUrl: '',
    authorization: p.authorization,
    id: current ?? p.draftId,
    maxBodyValueBytes: MAX_DRAFT_BODY_VALUE_BYTES,
  })
}

// Why the server refused to write a draft, phrased for the agent that has to
// fix it — or null when the failure was not the server saying no, in which case
// the caller rethrows rather than reporting a refusal that never happened.
//
// The attachment hint is the reason this exists. Stalwart answers an
// unresolvable `attachments` blobId with `blobNotFound`, which does not tell
// the agent what to do next — while "re-read the blobId" is very often the
// right move, because a blobId is per-account and does not outlive the message
// it was read from.
export const draftRefusalReason = (error: unknown, draft: EmailDraft): string | null => {
  if (!(error instanceof JmapError) || error.errorType === undefined) {
    return null
  }
  const hint =
    (draft.attachments ?? []).length > 0 && error.errorType === 'blobNotFound'
      ? ' The likeliest cause is an attachment blobId the server does not recognise: blobIds belong to one ' +
        'account and do not outlive the message they were read from, so re-read it with get_email or ' +
        'get_draft and use the blobId it reports now — or pass the file as base64 `content` instead.'
      : ''
  return `The server refused this draft (${error.errorType}).${hint}`
}

// The user-facing `$label:` tags on a message. Carried onto the replacement when
// a draft is edited: an edit rewrites the message, so without this a draft the
// user had filed under a label would come back untagged.
export const draftLabelKeywords = (record: EmailComposeRecord): string[] =>
  Object.entries(record.keywords ?? {})
    .filter(([keyword, set]) => set && keyword.startsWith(LABEL_KEYWORD_PREFIX))
    .map(([keyword]) => keyword)

// --- formatting ------------------------------------------------------------

// Apple Mail stages a draft as multipart/alternative with an empty text/plain
// part and the whole message in text/html. Read the stored text alone and that
// draft looks empty, so a blank text part falls back to the html, flattened to
// its words, and the body line says so. Display only: `draftFromRecord` keeps
// `text: ''`, so a rewrite of the draft keeps both parts as they were.
const previewSource = (draft: EmailDraft): { from: 'text' | 'html'; body: string } => {
  if (draft.text?.trim()) {
    return { from: 'text', body: draft.text }
  }
  const words = htmlToText(draft.html ?? '')
  if (draft.text !== undefined && !words) {
    return { from: 'text', body: draft.text }
  }
  return { from: 'html', body: words }
}

type PreviewSource = ReturnType<typeof previewSource>

const bodyKind = (draft: EmailDraft, source: PreviewSource): string => {
  if (draft.text !== undefined && draft.html !== undefined) {
    return source.from === 'html' ? 'text + html, text part blank, shown from html' : 'text + html'
  }
  if (draft.html !== undefined) {
    return 'html'
  }
  return 'text'
}

const bodyPreview = (draft: EmailDraft, source: PreviewSource): string => {
  const flat = source.body.replace(/\s+/gu, ' ').trim()
  if (!flat) {
    // An html part with markup but no words (an inline image, an empty link)
    // is not an empty draft, and must not read as one.
    return source.from === 'html' && draft.html?.trim() ? '(no text; the html part holds only markup)' : '(empty)'
  }
  return flat.length > BODY_PREVIEW_CHARS ? `${flat.slice(0, BODY_PREVIEW_CHARS)}…` : flat
}

export interface DraftFormatOptions {
  threadId?: string | null
  // Files the draft carries that this surface cannot re-reference (see
  // `unreferencableAttachments`). Reported separately from the draft itself,
  // and never folded into it: `EmailDraft.attachments` is the model a rewrite
  // is built from, so a placeholder blobId in there would eventually be sent to
  // the server. They still have to appear, because a review surface that says
  // "no attachments" about a draft holding one — and that send_draft will
  // deliver — is worse than one that says the file is there but unmanageable.
  unreferencable?: string[]
}

// The message itself, as a composition tool reports it back: resolved
// recipients and a body preview, so the agent can tell the user exactly what
// was staged (or sent) without a second call.
//
// The id line is the caller's to write, because the id means different things
// on the two paths — a `draftId` to send later, or the `messageId` of mail that
// has already gone — and printing "draftId" under a "Sent." heading would be
// actively misleading.
export const formatDraft = (draft: EmailDraft, opts: DraftFormatOptions = {}): string => {
  const lines = [`from: ${formatAddressList(draft.from)}`, `to: ${formatAddressList(draft.to) || '(none)'}`]
  if (draft.cc && draft.cc.length > 0) {
    lines.push(`cc: ${formatAddressList(draft.cc)}`)
  }
  if (draft.bcc && draft.bcc.length > 0) {
    lines.push(`bcc: ${formatAddressList(draft.bcc)}`)
  }
  lines.push(`subject: ${draft.subject || '(no subject)'}`)
  if (opts.threadId) {
    lines.push(`threadId: ${opts.threadId}`)
  }
  if (draft.inReplyTo && draft.inReplyTo.length > 0) {
    lines.push('threading: In-Reply-To/References set — this message continues an existing conversation')
  }
  const source = previewSource(draft)
  lines.push(`body (${bodyKind(draft, source)}): ${bodyPreview(draft, source)}`)
  lines.push(...attachmentLines(draft.attachments ?? [], opts.unreferencable ?? []))
  return lines.join('\n')
}

// What is attached, itemised. This is the half of the draft a human reviewing it
// cannot otherwise see — the body they can read back, but "did the invoice
// actually make it on?" is only answerable if the files are listed — so it is
// printed by every composition tool, not just get_draft.
//
// The blobId is on the line because it is the handle the next call needs: an
// update_draft that keeps this file, or a second message that attaches it too,
// both reference it and neither should have to re-upload anything.
const attachmentLines = (attachments: DraftAttachment[], unreferencable: string[]): string[] => {
  const total = attachments.length + unreferencable.length
  if (total === 0) {
    return []
  }
  return [
    `attachments (${total}):`,
    ...attachments.map((attachment, index) => {
      const pieces = [attachment.name ?? '(unnamed)', attachment.type ?? 'application/octet-stream']
      if (typeof attachment.size === 'number') {
        pieces.push(formatSize(attachment.size))
      }
      return `  ${index + 1}. ${pieces.join(' — ')} — blobId: ${attachment.blobId}`
    }),
    ...unreferencable.map(
      (name, index) =>
        `  ${attachments.length + index + 1}. ${name} — no blobId, so this file cannot be re-attached: it will ` +
        'be sent with the draft, but an edit here cannot carry it across. To change it, the user edits the draft in their mail app.'
    ),
  ]
}

// --- live-deps wiring ----------------------------------------------------

// `live` is shared across the JMAP tools (built once in the handler) so a
// bearer's session is resolved once per request cycle, not once per tool.
export const makeLiveDeps = (live: JmapLive): DraftToolDeps => ({
  blobUpload: async (p) => blobUpload({ ...p, uploadUrl: (await live.getSession(p.authorization)).uploadUrl }),
  draftCreate: async (p) => draftCreate({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  draftDestroy: async (p) => draftDestroy({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  draftIdResolve: async (p) => draftIdResolve({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  draftList: async (p) => draftList({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailComposeGet: async (p) => emailComposeGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailKeywordsSet: async (p) => emailSet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailSubmissionCreate: async (p) =>
    emailSubmissionCreate({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  identityGet: async (p) => identityGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  resolveAccountId: live.resolveAccountId,
  resolveComposeMailboxes: async (authorization) => {
    const session = await live.getSession(authorization)
    const byRole = await mailboxIdsByRoles({
      accountId: accountIdForMail(session),
      apiUrl: session.apiUrl,
      authorization,
      roles: ['drafts', 'sent', 'trash'],
    })
    return { drafts: byRole.drafts ?? null, sent: byRole.sent ?? null, trash: byRole.trash ?? null }
  },
  resolveSubmissionAccountId: async (authorization) => accountIdForSubmission(await live.getSession(authorization)),
  threadMessageFind: async (p) => threadMessageFind({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
})
