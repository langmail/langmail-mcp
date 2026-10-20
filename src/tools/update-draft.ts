// update_draft tool — edit a staged draft.
//
// The draft id does not change. RFC 8621 makes an Email's content immutable
// (only `keywords` and `mailboxIds` can be patched), so editing a draft means
// writing a new message and destroying the old one — see @langmail/jmap
// `drafts.ts`. The JMAP id therefore changes on every edit, but the replacement
// carries the draft's stable id as a `$draftid:` keyword (`stableDraftId` in
// draft-common.ts), so the id create_draft handed out keeps resolving to the
// current revision in get_draft, update_draft and send_draft.
//
// On a reply, `text` and `html` are the new part only: the quoted original is
// re-attached below them the way create_draft attaches it, if the staged draft
// carried it — so rewording a reply never drops the conversation it answers.
//
// Merge semantics are field-by-field: an omitted field keeps its staged value,
// a supplied one replaces it, and an empty recipient array clears that field.
// The sender and the threading headers are not editable — changing who a
// message is from or which conversation it belongs to is a different message,
// so stage it with create_draft.

import { randomUUID } from 'node:crypto'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  bearerAuthorization,
  type DraftAttachment,
  type DraftCreateResult,
  type EmailComposeRecord,
  type EmailDraft,
} from '@langmail/jmap'

import { attachmentsSchema, resolveAttachments } from '../drafts/attachments.ts'
import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import {
  bodyTruncated,
  type ComposeMailboxes,
  type DraftToolDeps,
  draftFromRecord,
  draftLabelKeywords,
  draftRefusalReason,
  formatDraft,
  isDraft,
  isTrashed,
  loadDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
  type ParsedRecipients,
  parseRecipients,
  replyOriginalId,
  replyOriginalKeyword,
  restoreFromTrashHint,
  stableDraftId,
  stableDraftIdKeyword,
  unreferencableAttachments,
} from './draft-common.ts'
import {
  carriesQuoteOf,
  quoteWithheldFrom,
  quoteWithheldNote,
  type ReplyBody,
  withQuotedOriginal,
} from './reply-quote.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const MAX_RECIPIENTS = 50
const MAX_BODY_CHARS = 100_000

const addressListSchema = (field: string): z.ZodOptional<z.ZodArray<z.ZodString>> =>
  z
    .array(z.string().min(3).max(320))
    .max(MAX_RECIPIENTS)
    .optional()
    .describe(
      `Replace the ${field} recipients. Omit to keep them; pass an empty array to clear them. Each entry ` +
        'is a bare address (person@example.com) or the "Name <person@example.com>" form.'
    )

export const updateDraftInput = z.object({
  attachments: attachmentsSchema
    .optional()
    .describe(
      `${attachmentsSchema.description} Omit to keep the files already attached; pass an empty array to ` +
        'remove them all. Supplying the field replaces the whole list, so to add one more file, list the ' +
        'existing ones by the blobIds get_draft reports alongside the new one.'
    ),
  bcc: addressListSchema('Bcc'),
  cc: addressListSchema('Cc'),
  draftId: z
    .string()
    .min(1)
    .describe(
      'The draft id, as returned by create_draft — edits do not change it — or a message id from search_emails ' +
        'with `mailbox: "Drafts"`. Editing a draft found that way returns the draftId to use from then on.'
    ),
  html: z
    .string()
    .max(MAX_BODY_CHARS)
    .optional()
    .describe(
      'Replace the HTML body. On a reply, write only the new part: the quoted original is re-attached below ' +
        'it, so do not paste the quote from get_draft back in. Omit to keep the body.'
    ),
  quoteOriginal: z
    .boolean()
    .optional()
    .describe(
      'On a reply, with `text` or `html`: whether the original is quoted below the new text. Defaults to ' +
        'whatever the staged draft does — unless the same call adds a `to`/`cc`/`bcc` recipient the ' +
        'original was not addressed to, where quoting would forward it to them, so the quote is left off. ' +
        'Pass false to drop the quote, true to add it to a bare reply or to quote it for a new recipient.'
    ),
  subject: z.string().max(500).optional().describe('Replace the subject. Omit to keep it.'),
  text: z
    .string()
    .max(MAX_BODY_CHARS)
    .optional()
    .describe(
      'Replace the plain-text body. On a reply, write only the new part: the quoted original is ' +
        're-attached below it, so do not paste the quote from get_draft back in. Omit to keep the body.'
    ),
  to: addressListSchema('To'),
})

export type UpdateDraftArgs = z.infer<typeof updateDraftInput>

export interface UpdateDraftContext {
  args: UpdateDraftArgs
  principal: string
  token: string
}

// Which body part would be left holding old content, if any.
//
// The test is on the *merged* result, not on what was staged: an html-only draft
// given a new `text` also ends up with both parts, one of them stale — and it is
// the html one, which is what clients render. Checking the staged draft for
// "has both" missed exactly that case.
const staleBodyPart = (
  staged: EmailDraft,
  args: UpdateDraftArgs
): { stale: 'html' | 'text'; supplied: 'html' | 'text' } | null => {
  const mergedHasText = args.text !== undefined || staged.text !== undefined
  const mergedHasHtml = args.html !== undefined || staged.html !== undefined
  if (!(mergedHasText && mergedHasHtml)) {
    return null
  }
  if (args.text !== undefined && args.html === undefined) {
    return { stale: 'html', supplied: 'text' }
  }
  if (args.html !== undefined && args.text === undefined) {
    return { stale: 'text', supplied: 'html' }
  }
  return null
}

// Whether the caller asked for any change at all. A bare `draftId` would
// otherwise replace and destroy the draft for nothing, running the
// replacement's failure modes for no benefit.
const editsNothing = (args: UpdateDraftArgs): boolean =>
  args.to === undefined &&
  args.cc === undefined &&
  args.bcc === undefined &&
  args.subject === undefined &&
  args.text === undefined &&
  args.html === undefined &&
  args.attachments === undefined

// The attachment list the replacement message should carry, or the reason one
// could not be built.
//
// Attachments merge like every other field: an omitted `attachments` keeps what
// is staged — which costs nothing, because the staged draft carries the existing
// blobIds and the re-create just re-references them — while a supplied list
// replaces the old one wholesale. `[]` goes down the supplied branch, which is
// what makes it mean "take the files off" rather than "leave them alone".
const mergedAttachments = async (
  deps: DraftToolDeps,
  p: { accountId: string; args: UpdateDraftArgs; authorization: string; staged: EmailDraft }
): Promise<{ attachments: DraftAttachment[] | undefined } | { error: string }> =>
  p.args.attachments === undefined
    ? { attachments: p.staged.attachments }
    : await resolveAttachments(deps, {
        accountId: p.accountId,
        authorization: p.authorization,
        entries: p.args.attachments,
      })

// The staged draft, or the reason it cannot be edited at all.
//
// The edit is a rewrite followed by a destroy, so anything the rewrite could
// not carry across would be lost for good — and reported as a success. Every
// refusal here therefore runs *before* the replacement is written, while the
// draft is still whole and nothing has changed.
const loadEditableDraft = async (
  deps: DraftToolDeps,
  p: { accountId: string; args: UpdateDraftArgs; authorization: string; mailboxes: ComposeMailboxes }
): Promise<{ error: ToolResult } | { record: EmailComposeRecord }> => {
  const { args } = p
  const record = await loadDraft(deps, {
    accountId: p.accountId,
    authorization: p.authorization,
    draftId: args.draftId,
  })
  if (!record) {
    return {
      error: errorResult(`Draft not found: ${args.draftId}. Find it with search_emails using mailbox "Drafts".`),
    }
  }
  if (!isDraft(record)) {
    return {
      error: errorResult(
        `${args.draftId} is not a draft — it has already been sent or received, and cannot be edited. Read ` +
          `it with get_email, passing id ${record.id}.`
      ),
    }
  }
  // Re-staging would put the discarded draft back into Drafts behind the
  // user's back.
  if (isTrashed(record, p.mailboxes)) {
    return {
      error: errorResult(
        `Draft ${args.draftId} is in Trash — it was discarded, so it was left unchanged. ` +
          restoreFromTrashHint(record)
      ),
    }
  }
  // A body that was truncated on the way in would be truncated on the way out.
  if (bodyTruncated(record)) {
    return {
      error: errorResult(
        `Draft ${args.draftId} has a body too large to edit without risking losing part of it, so it was left ` +
          'unchanged. Stage a fresh draft with create_draft instead.'
      ),
    }
  }
  // An attachment the replacement could not reference would be dropped by the
  // rewrite. Skipped when the caller is replacing the attachment list anyway:
  // they are not relying on the old files surviving.
  const unreferencable = args.attachments === undefined ? unreferencableAttachments(record) : []
  if (unreferencable.length > 0) {
    return {
      error: errorResult(
        `Draft ${args.draftId} carries a file this tool cannot carry across an edit ` +
          `(${unreferencable.join(', ')}), so it was left unchanged. Editing rewrites the message and destroys ` +
          'the original, which would lose the file for good. Edit it in Langmail, or pass `attachments` ' +
          'explicitly to say what the edited draft should carry.'
      ),
    }
  }
  return { record }
}

// The tail of an attribution line ("On …, Name <address> wrote:") in either
// body form — the end of a text line, `\r?` because `$` does not match before
// a CR, or the end of the `<div>` the HTML quote wraps it in — as a sign a body
// quotes something when the quoted message itself cannot be read.
const QUOTE_ATTRIBUTION_RE = / wrote:(?:\r?$|<\/div>)/mu

// Quoted history in either body form: a `>`-prefixed line or a blockquote.
const FOREIGN_QUOTE_RE = /^>|<blockquote\b/imu

// Both body parts, so a test finds a quote in whichever one carries it.
const bothParts = (draft: EmailDraft): string => `${draft.text ?? ''}\n${draft.html ?? ''}`

// The message a reply draft answers: the one create_draft recorded, failing
// that — a reply staged by another client — the one the thread holds, which it
// does only while the subject is unchanged. Resolved on every edit of a reply,
// not only on body edits, so it can be recorded on the replacement before a
// subject edit moves the reply out of that thread for good.
//
// A candidate counts only if its Message-ID is the one the draft's In-Reply-To
// names: a recorded id outlives the message it named, and should the server
// hand it to another message, quoting that one would put unrelated mail into
// the user's outgoing reply.
const replyOriginal = async (
  deps: DraftToolDeps,
  p: { accountId: string; authorization: string; record: EmailComposeRecord; staged: EmailDraft }
): Promise<EmailComposeRecord | null> => {
  const answers = p.staged.inReplyTo?.[0]
  if (!answers) {
    return null
  }
  const read = async (id: string): Promise<EmailComposeRecord | null> => {
    const candidate = await deps.emailComposeGet({
      accountId: p.accountId,
      apiUrl: '',
      authorization: p.authorization,
      bodyValues: 'body',
      id,
      maxBodyValueBytes: MAX_DRAFT_BODY_VALUE_BYTES,
    })
    return candidate?.messageId?.includes(answers) ? candidate : null
  }
  const recorded = replyOriginalId(p.record)
  const fromRecorded = recorded ? await read(recorded) : null
  if (fromRecorded) {
    return fromRecorded
  }
  // From here on the recorded id, if there was one, has been read and is
  // missing or names a different message, so a tolerated failure must not
  // carry it forward again.
  const disproved = (error: unknown): never => {
    throw recorded ? new RecordedOriginalDisproved(error) : error
  }
  const inThread = await deps
    .threadMessageFind({
      accountId: p.accountId,
      apiUrl: '',
      authorization: p.authorization,
      emailId: p.record.id,
      messageId: answers,
    })
    .catch(disproved)
  if (!(inThread && inThread !== recorded)) {
    return null
  }
  return await read(inThread).catch(disproved)
}

// A lookup that failed after the recorded original id was read and found to be
// missing or to name a different message — that id must not be recorded again.
class RecordedOriginalDisproved extends Error {
  constructor(cause: unknown) {
    super('the recorded original no longer matches, and the thread lookup failed', { cause })
  }
}

// What a failed lookup of the original costs depends on the edit. One that
// rewrites the body needs the original to quote, and one that changes the
// subject moves the reply out of the thread that could still find it — both
// fail loudly. Any other edit goes ahead, keeping whatever id was already
// recorded — the next edit can verify it, or find the original in the thread.
//
// `id` is what the replacement records; `record` is the original itself, when
// it was read and verified.
const replyOriginalForEdit = (
  deps: DraftToolDeps,
  p: { accountId: string; args: UpdateDraftArgs; authorization: string; record: EmailComposeRecord; staged: EmailDraft }
): Promise<{ id: string | null; record: EmailComposeRecord | null }> =>
  replyOriginal(deps, p).then(
    (original) => ({ id: original?.id ?? null, record: original }),
    (error: unknown) => {
      if (p.args.subject !== undefined || p.args.text !== undefined || p.args.html !== undefined) {
        throw error
      }
      return { id: error instanceof RecordedOriginalDisproved ? null : replyOriginalId(p.record), record: null }
    }
  )

// Every address that is the user — the authenticated principal, the draft's
// sender, and every identity the account can send as — as `resolveIdentity`
// counts them (see `ResolvedIdentity.selfAddresses`). Read only when an edit
// puts the quote in front of recipients that have not been checked against the
// original — one that adds recipients to a quoted reply, or one that pastes the
// quote onto a reply that did not carry it.
const selfAddressesOf = async (
  deps: DraftToolDeps,
  p: { authorization: string; principal: string; staged: EmailDraft }
): Promise<string[]> => {
  const identities = await deps.identityGet({
    accountId: await deps.resolveSubmissionAccountId(p.authorization),
    apiUrl: '',
    authorization: p.authorization,
  })
  return [
    p.principal,
    ...p.staged.from.map((address) => address.email),
    ...identities.map((identity) => identity.email),
  ]
}

// Someone this edit adds who the original was never addressed to, or null.
// When the staged body already carried the quote, only an added recipient
// counts: everyone already on the draft was allowed to see the original, and
// re-passing them is not a new decision. When it did not — the quote arrives
// in the caller's own text — nobody on the draft has seen it yet, so every
// recipient is checked.
const outsiderShownQuote = async (
  deps: DraftToolDeps,
  p: {
    args: UpdateDraftArgs
    authorization: string
    original: EmailComposeRecord
    principal: string
    recipients: ParsedRecipients
    staged: EmailDraft
    stagedCarriedQuote: boolean
  }
): Promise<string | null> => {
  // With the quote already staged, an edit that touches no recipients leaves
  // the disclosure where it was. Without it, the quote is new to everyone.
  if (p.stagedCarriedQuote && p.args.to === undefined && p.args.cc === undefined && p.args.bcc === undefined) {
    return null
  }
  const alreadyNamed = p.stagedCarriedQuote
    ? [...(p.staged.to ?? []), ...(p.staged.cc ?? []), ...(p.staged.bcc ?? [])]
    : []
  return quoteWithheldFrom(p.original, p.recipients, [
    ...(await selfAddressesOf(deps, p)),
    ...alreadyNamed.map((address) => address.email),
  ])
}

// What to say when the original cannot be read, so no quote can be re-attached.
// Only worth saying when a quote was wanted or looks to have been there — in
// this tool's format or another client's — since a bare reply never had one to
// lose.
const missingOriginalNote = (args: UpdateDraftArgs, staged: EmailDraft): { note?: string } => {
  const body = bothParts(staged)
  const wanted = args.quoteOriginal === true || QUOTE_ATTRIBUTION_RE.test(body) || FOREIGN_QUOTE_RE.test(body)
  return wanted
    ? {
        note:
          'The message this draft replies to could not be found, so no quote was re-attached: the body is ' +
          'exactly the text given.',
      }
    : {}
}

// The note for quoted text going to someone the original was never addressed to.
// Dropping that recipient again works on every path, and is the only remedy for
// a body another mail client wrote: the agent cannot read it back whole, so it
// has no "own wording" to pass. The other remedy needs both halves. Without `quoteOriginal: false`, the staged body
// this edit writes — quote included — makes the next edit's default re-attach
// it; and `quoteOriginal: false` on a text that still holds the quote stages it
// verbatim.
const quotedTextNote = (outsider: string): string =>
  `The draft carries quoted text from the original, and ${outsider} was not on it, so that now goes to them ` +
  'too. To take it off, drop that recipient again, or pass your own wording again — without the quoted ' +
  'part — with `quoteOriginal: false`.'

// An edit that leaves the body alone re-stages it as it is, quote included —
// the same as changing the recipients of a quoted reply in a mail client. When
// that edit adds someone the original was never addressed to, the quote now
// goes to them too: say so, since the agent did not ask for it in so many
// words, and say how to take it off.
const stagedQuoteNote = async (
  deps: DraftToolDeps,
  p: {
    args: UpdateDraftArgs
    authorization: string
    original: EmailComposeRecord | null
    principal: string
    recipients: ParsedRecipients
    staged: EmailDraft
  }
): Promise<{ note?: string }> => {
  // Any quoted history counts — another client's quote as much as one this
  // tool wrote. The note is advisory, so a hand-typed `>` line costs a spare
  // sentence, never a changed body. Without the original there is no roster
  // to compare against, so nothing is said.
  const { original } = p
  if (!(original && (carriesQuoteOf(p.staged, original) || FOREIGN_QUOTE_RE.test(bothParts(p.staged))))) {
    return {}
  }
  const outsider = await outsiderShownQuote(deps, { ...p, original, stagedCarriedQuote: true })
  return outsider
    ? {
        note: quotedTextNote(outsider),
      }
    : {}
}

// The body the edit stages: what the caller supplied, with the original quoted
// below it when the draft is a reply that quotes it (or the caller asks for the
// quote). `note` says when a quote could not be re-attached, so the agent learns
// the reply now goes out without it.
//
// The default follows the staged draft rather than the recipient rule
// create_draft applies: the quoting decision was made when the reply was staged
// — by the user, when they asked for a quote despite a new recipient — and an
// edit of the wording is not a reason to revisit it. An edit that also changes
// the recipients is: re-attaching the quote for someone the original was never
// addressed to would forward it to them, so that takes `quoteOriginal: true`,
// as it does on create_draft. An edit that leaves the body alone keeps the
// staged quote as it is and only says so — see `stagedQuoteNote`.
const editedBody = async (
  deps: DraftToolDeps,
  p: {
    args: UpdateDraftArgs
    authorization: string
    original: EmailComposeRecord | null
    principal: string
    recipients: ParsedRecipients
    staged: EmailDraft
  }
): Promise<{ body: ReplyBody; note?: string }> => {
  const { args, original } = p
  const supplied: ReplyBody = {
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.html === undefined ? {} : { html: args.html }),
  }
  if (args.text === undefined && args.html === undefined) {
    return { body: supplied, ...(await stagedQuoteNote(deps, p)) }
  }
  if (!p.staged.inReplyTo?.[0] || args.quoteOriginal === false) {
    return { body: supplied }
  }
  if (!original) {
    return { body: supplied, ...missingOriginalNote(args, p.staged) }
  }
  // A caller who passed the whole body, quote included, gets it as written
  // rather than quoted twice.
  if (carriesQuoteOf(supplied, original)) {
    // The quote came in the caller's own text, so it goes out as written — but
    // an added outsider is told about, as on a recipients-only edit.
    const outsider =
      args.quoteOriginal === undefined
        ? await outsiderShownQuote(deps, { ...p, original, stagedCarriedQuote: carriesQuoteOf(p.staged, original) })
        : null
    return outsider ? { body: supplied, note: quotedTextNote(outsider) } : { body: supplied }
  }
  if (!(args.quoteOriginal ?? carriesQuoteOf(p.staged, original))) {
    // A quote in a format this tool did not write — another mail client's —
    // goes with the old wording. Say so, since the description promised the
    // quote would be kept.
    const foreignQuote = args.quoteOriginal === undefined && FOREIGN_QUOTE_RE.test(bothParts(p.staged))
    return {
      body: supplied,
      ...(foreignQuote
        ? {
            note:
              'The staged body held quoted text in a format this tool did not write, and it was replaced along ' +
              'with the old wording. Pass `quoteOriginal: true` with the text to quote the original below it.',
          }
        : {}),
    }
  }
  const outsider =
    args.quoteOriginal === undefined
      ? await outsiderShownQuote(deps, { ...p, original, stagedCarriedQuote: true })
      : null
  if (outsider) {
    return { body: supplied, note: quoteWithheldNote(outsider) }
  }
  return { body: withQuotedOriginal(supplied, original) }
}

// Why the arguments alone describe no edit, if they don't — checked before
// anything is read.
const argumentRefusal = (args: UpdateDraftArgs): ToolResult | null => {
  if (args.quoteOriginal !== undefined && args.text === undefined && args.html === undefined) {
    return errorResult(
      '`quoteOriginal` only applies together with a new `text` or `html`: pass the new wording as well. ' +
        `Draft ${args.draftId} was left unchanged.`
    )
  }
  if (editsNothing(args)) {
    return errorResult(
      `No changes were given, so draft ${args.draftId} was left exactly as it is. Pass at least one of ` +
        'to/cc/bcc/subject/text/html/attachments to edit it.'
    )
  }
  return null
}

// The result of a landed edit.
const updatedSummary = (p: {
  args: UpdateDraftArgs
  created: DraftCreateResult
  draftId: string
  merged: EmailDraft
  note: string | undefined
  replacedId: string
}): string => {
  // A create that landed while the destroy didn't leaves the superseded copy in
  // the folder, holding the *pre-edit* content. The draftId resolves to the new
  // revision (see `loadDraft`), but the user sees two drafts in their client, so
  // the note says which one is stale.
  const leftover =
    p.created.replacedDestroyed === false
      ? `\nNote: the pre-edit copy (message ${p.replacedId}) could not be removed and is still in Drafts. ` +
        `send_draft with draftId ${p.draftId} sends the edited version. Do not send ${p.replacedId}; with the ` +
        "user's OK, remove it with trash_emails."
      : ''
  const note = p.note ? `\n${p.note}` : ''
  // A caller who came in with a revision's message id (from search_emails) is
  // told the id that keeps working; one who held the draftId already is told it
  // still does.
  const heading =
    p.args.draftId === p.draftId
      ? 'Draft updated and still unsent — the draftId is unchanged.'
      : `Draft updated and still unsent. Its draftId is ${p.draftId}; use that from now on.`
  return `${heading}\ndraftId: ${p.draftId}\n${formatDraft(p.merged, { threadId: p.created.threadId })}${note}${leftover}`
}

export const updateDraft = async (deps: DraftToolDeps, ctx: UpdateDraftContext): Promise<ToolResult> => {
  const { args } = ctx
  const refused = argumentRefusal(args)
  if (refused) {
    return refused
  }
  const authorization = bearerAuthorization(ctx.token)
  const accountId = await deps.resolveAccountId(authorization)

  const mailboxes = await deps.resolveComposeMailboxes(authorization)
  const loaded = await loadEditableDraft(deps, { accountId, args, authorization, mailboxes })
  if ('error' in loaded) {
    return loaded.error
  }
  const { record } = loaded

  const staged = draftFromRecord(record)
  // Replacing one body part while the other survives is how a stale body gets
  // delivered: mail clients render the html alternative, so an html draft
  // "corrected" via `text` alone goes out saying the old thing. Both parts or
  // neither.
  const stalePart = staleBodyPart(staged, args)
  if (stalePart) {
    return errorResult(
      `This draft has both a plain-text and an HTML body, and only \`${stalePart.supplied}\` was given — the ` +
        `\`${stalePart.stale}\` version would keep its old content, and that is the one most mail clients ` +
        'show. Pass both `text` and `html`, or stage a fresh draft with create_draft. Nothing was changed.'
    )
  }

  const recipients = parseRecipients({
    ...(args.to ? { to: args.to } : {}),
    ...(args.cc ? { cc: args.cc } : {}),
    ...(args.bcc ? { bcc: args.bcc } : {}),
  })
  if ('error' in recipients) {
    return errorResult(recipients.error)
  }

  if (!mailboxes.drafts) {
    return errorResult('This account has no Drafts folder, so the draft cannot be re-staged.')
  }

  const attachments = await mergedAttachments(deps, { accountId, args, authorization, staged })
  if ('error' in attachments) {
    return errorResult(attachments.error)
  }

  // Recorded by create_draft, or found in the thread just now — kept on the
  // replacement either way, so the next edit does not have to search again.
  const resolvedOriginal = await replyOriginalForEdit(deps, { accountId, args, authorization, record, staged })
  const mergedRecipients: ParsedRecipients = {
    to: recipients.to ?? staged.to ?? [],
    cc: recipients.cc ?? staged.cc ?? [],
    bcc: recipients.bcc ?? staged.bcc ?? [],
  }
  const edited = await editedBody(deps, {
    args,
    authorization,
    original: resolvedOriginal.record,
    principal: ctx.principal,
    recipients: mergedRecipients,
    staged,
  })
  const merged: EmailDraft = {
    ...staged,
    ...recipients,
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...edited.body,
    ...(attachments.attachments === undefined ? {} : { attachments: attachments.attachments }),
  }
  // A draft another client staged gets its token now — see `stableDraftId`.
  const draftId = stableDraftId(record) ?? randomUUID()

  let created: DraftCreateResult
  try {
    created = await deps.draftCreate({
      accountId,
      apiUrl: '',
      authorization,
      draft: merged,
      mailboxId: mailboxes.drafts,
      // The user's own labels survive the edit — an edit shouldn't quietly
      // untag a draft they filed. The reply's original rides along so the next
      // edit can quote it, and the stable id is what keeps the caller's
      // draftId pointing at this revision.
      keywords: [
        ...draftLabelKeywords(record),
        ...(resolvedOriginal.id ? [replyOriginalKeyword(resolvedOriginal.id)] : []),
        stableDraftIdKeyword(draftId),
      ],
      replaces: record.id,
    })
  } catch (error) {
    const refusal = draftRefusalReason(error, merged)
    if (refusal === null) {
      throw error
    }
    // The destroy only runs once the replacement exists (@langmail/jmap
    // drafts.ts), so a refused create leaves the original exactly as it was.
    return errorResult(`${refusal} Draft ${args.draftId} was left unchanged.`)
  }

  return textResult(updatedSummary({ args, created, draftId, merged, note: edited.note, replacedId: record.id }))
}

// --- MCP registration ----------------------------------------------------

export const registerUpdateDraft = (
  server: McpServer,
  deps: DraftToolDeps,
  // Bearer + principal are threaded per request — see mcp/handler.ts.
  getToken: () => string,
  getPrincipal: () => string
): void => {
  server.registerTool(
    'update_draft',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Edit a staged draft that has not been sent. Omitted fields keep their staged values; an empty ' +
        'recipient or `attachments` array clears that field. Files already attached are carried across ' +
        'untouched unless `attachments` is given, in which case the list is replaced wholesale — read the ' +
        'existing blobIds back with get_draft first if you mean to add one rather than swap them. The ' +
        'draftId stays the same across edits, so keep using the one create_draft returned. On a reply, ' +
        '`text`/`html` is the new part only: the quoted original is kept below it (`quoteOriginal: false` ' +
        'drops it, `true` adds one to a bare reply). The previous version is not recoverable. If the draft has both a plain-text and an HTML body, pass ' +
        'both `text` and `html` or neither; replacing one would leave the other saying the old thing. The ' +
        'sender and the reply threading cannot be changed here; stage a new draft with create_draft instead, then retire this one ' +
        'with delete_draft.',
      inputSchema: updateDraftInput.shape,
      title: 'Update draft',
    },
    (args) => {
      const parsed = updateDraftInput.parse(args)
      return updateDraft(deps, { args: parsed, principal: getPrincipal(), token: getToken() })
    }
  )
}
