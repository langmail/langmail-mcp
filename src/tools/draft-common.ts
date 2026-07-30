// Shared plumbing for the composition tools (create_draft, get_draft,
// update_draft, send_draft, reply_to_message).
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
  DRAFT_KEYWORD,
  type DraftCreateParams,
  type DraftCreateResult,
  draftCreate,
  type EmailAddress,
  type EmailComposeGetParams,
  type EmailComposeRecord,
  type EmailDraft,
  type EmailSubmissionCreateParams,
  type EmailSubmissionResult,
  emailComposeGet,
  emailSubmissionCreate,
  type IdentityGetParams,
  type IdentityRecord,
  identityGet,
  type JmapLive,
  LABEL_KEYWORD_PREFIX,
  mailboxIdsByRoles,
} from '@langmail/jmap'

import { formatAddressList } from './format.ts'

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
// "Sent Items", and a name lookup for "Sent" misses the second one.
export interface ComposeMailboxes {
  drafts: string | null
  sent: string | null
}

export interface DraftToolDeps {
  draftCreate: (p: DraftCreateParams) => Promise<DraftCreateResult>
  emailComposeGet: (p: EmailComposeGetParams) => Promise<EmailComposeRecord | null>
  emailSubmissionCreate: (p: EmailSubmissionCreateParams) => Promise<EmailSubmissionResult>
  identityGet: (p: IdentityGetParams) => Promise<IdentityRecord[]>
  resolveAccountId: (authorization: string) => Promise<string>
  resolveComposeMailboxes: (authorization: string) => Promise<ComposeMailboxes>
  // Identities and submissions hang off the submission capability's account,
  // which Stalwart co-locates with mail but the session resource may name
  // separately.
  resolveSubmissionAccountId: (authorization: string) => Promise<string>
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
// `name` — and Langmail's provisioning (services/auth `createAccount`) sets no
// description, so today it resolves to the mailbox local part rather than a
// human name. That's a provisioning gap, not one to paper over here: webmail
// sends under the same Identity, so whatever it says, both surfaces agree.
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
export const bodyTruncated = (record: EmailComposeRecord): boolean =>
  Object.values(record.bodyValues ?? {}).some((value) => value.isTruncated === true)

// Read a stored draft back into the composable shape, so update_draft can merge
// changes onto it and re-create the message (RFC 8621 makes an Email's content
// immutable — see @langmail/jmap drafts.ts).
export const draftFromRecord = (record: EmailComposeRecord): EmailDraft => {
  const text = bodyOfType(record, record.textBody, 'text/plain')
  const html = bodyOfType(record, record.htmlBody, 'text/html')
  return {
    from: record.from ?? [],
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

// The user-facing `$label:` tags on a message. Carried onto the replacement when
// a draft is edited: an edit rewrites the message, so without this a draft the
// user had filed under a label would come back untagged.
export const draftLabelKeywords = (record: EmailComposeRecord): string[] =>
  Object.entries(record.keywords ?? {})
    .filter(([keyword, set]) => set && keyword.startsWith(LABEL_KEYWORD_PREFIX))
    .map(([keyword]) => keyword)

// --- formatting ------------------------------------------------------------

const bodyKind = (draft: EmailDraft): string => {
  if (draft.text !== undefined && draft.html !== undefined) {
    return 'text + html'
  }
  if (draft.html !== undefined) {
    return 'html'
  }
  return 'text'
}

const bodyPreview = (draft: EmailDraft): string => {
  const flat = (draft.text ?? draft.html ?? '').replace(/\s+/gu, ' ').trim()
  if (!flat) {
    return '(empty)'
  }
  return flat.length > BODY_PREVIEW_CHARS ? `${flat.slice(0, BODY_PREVIEW_CHARS)}…` : flat
}

export interface DraftFormatOptions {
  threadId?: string | null
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
  lines.push(`body (${bodyKind(draft)}): ${bodyPreview(draft)}`)
  return lines.join('\n')
}

// --- live-deps wiring ----------------------------------------------------

// `live` is shared across the JMAP tools (built once in the handler) so a
// bearer's session is resolved once per request cycle, not once per tool.
export const makeLiveDeps = (live: JmapLive): DraftToolDeps => ({
  draftCreate: async (p) => draftCreate({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  emailComposeGet: async (p) => emailComposeGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
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
      roles: ['drafts', 'sent'],
    })
    return { drafts: byRole.drafts ?? null, sent: byRole.sent ?? null }
  },
  resolveSubmissionAccountId: async (authorization) => accountIdForSubmission(await live.getSession(authorization)),
})
