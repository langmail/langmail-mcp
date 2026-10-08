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
  type DraftToolDeps,
  draftFromRecord,
  draftLabelKeywords,
  draftRefusalReason,
  formatDraft,
  isDraft,
  loadDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
  parseRecipients,
  replyOriginalId,
  replyOriginalKeyword,
  stableDraftId,
  stableDraftIdKeyword,
  unreferencableAttachments,
} from './draft-common.ts'
import { carriesQuoteOf, type ReplyBody, withQuotedOriginal } from './reply-quote.ts'
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
      'The draft id, as returned by create_draft, or a message id from search_emails with `mailbox: "Drafts"`. ' +
        'Edits do not change it.'
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
        'whatever the staged draft does. Pass false to drop the quote, true to add it to a bare reply.'
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
// Every refusal here shares one shape: the edit is a rewrite followed by a
// destroy, so anything the rewrite could not carry across would be lost for
// good — and reported as a success. All of these therefore run *before* the
// replacement is written, while the draft is still whole and nothing has
// changed.
const loadEditableDraft = async (
  deps: DraftToolDeps,
  p: { accountId: string; args: UpdateDraftArgs; authorization: string }
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
        `${args.draftId} is not a draft — it has already been sent or received, and cannot be edited.`
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

// The body the edit stages: what the caller supplied, with the original quoted
// below it when the draft is a reply that quotes it (or the caller asks for the
// quote). `note` says when a quote could not be re-attached, so the agent learns
// the reply now goes out without it.
//
// The default follows the staged draft rather than the recipient rule
// create_draft applies: the quoting decision was made when the reply was staged
// — by the user, when they asked for a quote despite a new recipient — and an
// edit of the wording is not a reason to revisit it.
// The tail of an attribution line ("On …, Name <address> wrote:"), as a sign a
// body quotes something when the quoted message itself cannot be read.
const QUOTE_ATTRIBUTION_RE = / wrote:$/mu

// Quoted history in either body form: a `>`-prefixed line or a blockquote.
const FOREIGN_QUOTE_RE = /^>|<blockquote\b/imu

const editedBody = async (
  deps: DraftToolDeps,
  p: { accountId: string; args: UpdateDraftArgs; authorization: string; record: EmailComposeRecord; staged: EmailDraft }
): Promise<{ body: ReplyBody; note?: string; originalId?: string }> => {
  const { args } = p
  const supplied: ReplyBody = {
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.html === undefined ? {} : { html: args.html }),
  }
  const answers = p.staged.inReplyTo?.[0]
  if ((args.text === undefined && args.html === undefined) || !answers || args.quoteOriginal === false) {
    return { body: supplied }
  }
  // The id create_draft recorded; failing that — a reply staged by another
  // client — the thread, which holds the original as long as the subject has
  // not changed.
  const originalId =
    replyOriginalId(p.record) ??
    (await deps.threadMessageFind({
      accountId: p.accountId,
      apiUrl: '',
      authorization: p.authorization,
      emailId: p.record.id,
      messageId: answers,
    }))
  const original = originalId
    ? await deps.emailComposeGet({
        accountId: p.accountId,
        apiUrl: '',
        authorization: p.authorization,
        bodyValues: 'body',
        id: originalId,
        maxBodyValueBytes: MAX_DRAFT_BODY_VALUE_BYTES,
      })
    : null
  if (!original) {
    // Only worth saying when a quote was wanted or looks to have been there —
    // a bare reply never had one to lose.
    const wanted = args.quoteOriginal === true || QUOTE_ATTRIBUTION_RE.test(p.staged.text ?? p.staged.html ?? '')
    return wanted
      ? {
          body: supplied,
          note:
            'The message this draft replies to could not be found, so no quote was re-attached: the body is ' +
            'exactly the text given.',
        }
      : { body: supplied }
  }
  // A caller who passed the whole body, quote included, gets it as written
  // rather than quoted twice.
  if (carriesQuoteOf(supplied, original)) {
    return { body: supplied, originalId: original.id }
  }
  if (!(args.quoteOriginal ?? carriesQuoteOf(p.staged, original))) {
    // A quote in a format this tool did not write — another mail client's —
    // goes with the old wording. Say so, since the description promised the
    // quote would be kept.
    const foreignQuote = args.quoteOriginal === undefined && FOREIGN_QUOTE_RE.test(p.staged.text ?? p.staged.html ?? '')
    return {
      body: supplied,
      originalId: original.id,
      ...(foreignQuote
        ? {
            note:
              'The staged body held quoted text in a format this tool did not write, and it was replaced along ' +
              'with the old wording. Pass `quoteOriginal: true` with the text to quote the original below it.',
          }
        : {}),
    }
  }
  return { body: withQuotedOriginal(supplied, original), originalId: original.id }
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

  const loaded = await loadEditableDraft(deps, { accountId, args, authorization })
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

  const mailboxes = await deps.resolveComposeMailboxes(authorization)
  if (!mailboxes.drafts) {
    return errorResult('This account has no Drafts folder, so the draft cannot be re-staged.')
  }

  const attachments = await mergedAttachments(deps, { accountId, args, authorization, staged })
  if ('error' in attachments) {
    return errorResult(attachments.error)
  }

  const edited = await editedBody(deps, { accountId, args, authorization, record, staged })
  const merged: EmailDraft = {
    ...staged,
    ...recipients,
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...edited.body,
    ...(attachments.attachments === undefined ? {} : { attachments: attachments.attachments }),
  }
  // A draft another client staged gets its token now — see `stableDraftId`.
  const draftId = stableDraftId(record) ?? randomUUID()
  // Recorded by create_draft, or found in the thread just now — kept either way
  // so the next edit does not have to search again.
  const originalId = edited.originalId ?? replyOriginalId(record)

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
        ...(originalId ? [replyOriginalKeyword(originalId)] : []),
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

export const registerUpdateDraft = (server: McpServer, deps: DraftToolDeps, getToken: () => string): void => {
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
        'sender and the reply threading cannot be changed here; stage a new draft with create_draft instead.',
      inputSchema: updateDraftInput.shape,
      title: 'Update draft',
    },
    (args) => {
      const parsed = updateDraftInput.parse(args)
      return updateDraft(deps, { args: parsed, token: getToken() })
    }
  )
}
