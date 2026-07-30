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

import { ACCOUNT_WRITE } from './annotations.ts'
import {
  type DraftToolDeps,
  draftFromRecord,
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

export const updateDraft = async (deps: DraftToolDeps, ctx: UpdateDraftContext): Promise<ToolResult> => {
  const { args } = ctx
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
    ...draftFromRecord(record),
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
    replaces: args.draftId,
  })

  // A create that landed while the destroy didn't leaves the superseded draft in
  // the folder. Saying so beats the user finding two drafts and neither tool
  // admitting to it.
  const leftover =
    created.replacedDestroyed === false
      ? `\nNote: the previous draft ${args.draftId} could not be removed and is still in Drafts.`
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
      annotations: ACCOUNT_WRITE,
      description:
        'Edit a staged draft that has not been sent. Omitted fields keep their staged values; an empty ' +
        'recipient array clears that field. Returns a NEW draftId — the edit replaces the message, so the ' +
        'old id stops working and later calls (including send_draft) must use the returned one. The sender ' +
        'and the reply threading cannot be changed here; stage a new draft with create_draft instead.',
      inputSchema: updateDraftInput.shape,
      title: 'Update draft',
    },
    (args) => {
      const parsed = updateDraftInput.parse(args)
      return updateDraft(deps, { args: parsed, token: getToken() })
    }
  )
}
