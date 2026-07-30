// update_draft tool — edit a staged draft.
//
// The draft id changes. RFC 8621 makes an Email's content immutable (only
// `keywords` and `mailboxIds` can be patched), so editing a draft means writing
// a new message and destroying the old one — see @langmail/jmap `drafts.ts`,
// which does both halves in one Email/set so the edit is never visible as two
// drafts. The new id is returned and is the one send_draft must be given.
//
// Merge semantics are field-by-field: an omitted field keeps its staged value,
// a supplied one replaces it, and an empty recipient array clears that field.
// The sender and the threading headers are not editable — changing who a
// message is from or which conversation it belongs to is a different message,
// so stage it with create_draft.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization, type EmailDraft } from '@langmail/jmap'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import {
  bodyTruncated,
  type DraftToolDeps,
  draftFromRecord,
  draftLabelKeywords,
  formatDraft,
  isDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
  parseRecipients,
} from './draft-common.ts'
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
  bcc: addressListSchema('Bcc'),
  cc: addressListSchema('Cc'),
  draftId: z.string().min(1).describe('The draft to edit, as returned by create_draft or a previous update_draft.'),
  html: z.string().max(MAX_BODY_CHARS).optional().describe('Replace the HTML body. Omit to keep it.'),
  subject: z.string().max(500).optional().describe('Replace the subject. Omit to keep it.'),
  text: z.string().max(MAX_BODY_CHARS).optional().describe('Replace the plain-text body. Omit to keep it.'),
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
// otherwise replace and destroy the draft for nothing, invalidating every stored
// reference to it and running the replacement's failure modes for no benefit.
const editsNothing = (args: UpdateDraftArgs): boolean =>
  args.to === undefined &&
  args.cc === undefined &&
  args.bcc === undefined &&
  args.subject === undefined &&
  args.text === undefined &&
  args.html === undefined

export const updateDraft = async (deps: DraftToolDeps, ctx: UpdateDraftContext): Promise<ToolResult> => {
  const { args } = ctx
  if (editsNothing(args)) {
    return errorResult(
      `No changes were given, so draft ${args.draftId} was left exactly as it is — its id still works. Pass at ` +
        'least one of to/cc/bcc/subject/text/html to edit it.'
    )
  }
  const authorization = bearerAuthorization(ctx.token)
  const accountId = await deps.resolveAccountId(authorization)

  const record = await deps.emailComposeGet({
    accountId,
    apiUrl: '',
    authorization,
    id: args.draftId,
    maxBodyValueBytes: MAX_DRAFT_BODY_VALUE_BYTES,
  })
  if (!record) {
    return errorResult(`Draft not found: ${args.draftId}`)
  }
  if (!isDraft(record)) {
    return errorResult(`${args.draftId} is not a draft — it has already been sent or received, and cannot be edited.`)
  }
  // An edit re-stages whatever came back, so a body that was truncated on the way
  // in would be truncated on the way out — and the original is destroyed after.
  // Refusing keeps the user's message intact; nothing has changed at this point.
  if (bodyTruncated(record)) {
    return errorResult(
      `Draft ${args.draftId} has a body too large to edit without risking losing part of it, so it was left ` +
        'unchanged. Stage a fresh draft with create_draft instead.'
    )
  }

  // Editing rewrites the message, and composition has no attachment support, so
  // the attachments of a draft written elsewhere cannot be carried across. Losing
  // a file the user deliberately attached is worse than refusing the edit — and
  // the original is destroyed on the way, so it would be unrecoverable.
  if ((record.attachments ?? []).length > 0) {
    return errorResult(
      `Draft ${args.draftId} has attachments, which this tool cannot preserve, so it was left unchanged. Edit ` +
        'it in Langmail instead.'
    )
  }

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

  const merged: EmailDraft = {
    ...staged,
    ...recipients,
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.html === undefined ? {} : { html: args.html }),
  }

  const created = await deps.draftCreate({
    accountId,
    apiUrl: '',
    authorization,
    draft: merged,
    mailboxId: mailboxes.drafts,
    // The user's own labels survive the edit — an edit shouldn't quietly
    // untag a draft they filed.
    keywords: draftLabelKeywords(record),
    replaces: args.draftId,
  })

  // A create that landed while the destroy didn't leaves the superseded draft in
  // the folder — still sendable, and still holding the *pre-edit* content. That
  // makes it actively dangerous, not just untidy, so the note says which id to
  // send and which to leave alone.
  const leftover =
    created.replacedDestroyed === false
      ? `\nNote: the previous draft ${args.draftId} could not be removed and is still in Drafts. It holds the ` +
        `PRE-EDIT content and is still sendable — do not send it; send ${created.id}.`
      : ''
  return textResult(
    `Draft updated and still unsent — its id is now ${created.id} (the previous id is gone; use the new one ` +
      `for send_draft).\ndraftId: ${created.id}\n${formatDraft(merged, { threadId: created.threadId })}${leftover}`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerUpdateDraft = (server: McpServer, deps: DraftToolDeps, getToken: () => string): void => {
  server.registerTool(
    'update_draft',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Edit a staged draft that has not been sent. Omitted fields keep their staged values; an empty ' +
        'recipient array clears that field. Returns a NEW draftId — the edit replaces the message, so the ' +
        'old id stops working and later calls (including send_draft) must use the returned one. The ' +
        'previous version is not recoverable. If the draft has both a plain-text and an HTML body, pass ' +
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
