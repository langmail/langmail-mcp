// get_draft tool — read a staged draft back exactly as it will be sent.
//
// get_email deliberately can't do this job: it renders a message through the
// langmail cleaning pipeline (markdown out, whatever the sender put in) and
// never shows `bcc`, because a received message has none. A draft needs the
// literal staged fields — blind-copied recipients included — or the agent can't
// report what it actually staged and update_draft can't merge onto it.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { bearerAuthorization } from '@langmail/jmap'

import { READ_ONLY } from './annotations.ts'
import {
  type DraftToolDeps,
  draftFromRecord,
  formatDraft,
  isDraft,
  isTrashed,
  loadDraft,
  restoreFromTrashHint,
  stableDraftId,
  unreferencableAttachments,
} from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

export const getDraftInput = z.object({
  draftId: z
    .string()
    .min(1)
    .describe(
      'The draft id, as returned by create_draft, update_draft or list_drafts — edits do not change it — or a ' +
        'message id from search_emails with `mailbox: "Drafts"`, which an edit replaces with the draftId it returns.'
    ),
})

export type GetDraftArgs = z.infer<typeof getDraftInput>

export interface GetDraftContext {
  args: GetDraftArgs
  token: string
}

export const getDraft = async (deps: DraftToolDeps, ctx: GetDraftContext): Promise<ToolResult> => {
  const authorization = bearerAuthorization(ctx.token)
  const accountId = await deps.resolveAccountId(authorization)
  const record = await loadDraft(deps, { accountId, authorization, draftId: ctx.args.draftId })
  if (!record) {
    return errorResult(`Draft not found: ${ctx.args.draftId}. Find it with list_drafts.`)
  }
  if (!isDraft(record)) {
    return errorResult(
      `${ctx.args.draftId} is not a draft — it has already been sent or received. Read it with get_email ` +
        `instead, passing id ${record.id}.`
    )
  }
  if (isTrashed(record, await deps.resolveComposeMailboxes(authorization))) {
    return errorResult(
      `Draft ${ctx.args.draftId} is in Trash — it was discarded and is no longer pending. ${restoreFromTrashHint(record)}`
    )
  }
  return textResult(
    `Draft (not sent):\ndraftId: ${stableDraftId(record) ?? record.id}\n${formatDraft(draftFromRecord(record), {
      threadId: record.threadId,
      // A file with no blobId is dropped from the composable model, so without
      // this the one surface a human reviews the draft on would report it as
      // carrying nothing.
      unreferencable: unreferencableAttachments(record),
    })}`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerGetDraft = (server: McpServer, deps: DraftToolDeps, getToken: () => string): void => {
  server.registerTool(
    'get_draft',
    {
      annotations: READ_ONLY,
      description:
        'Read a staged draft back: its sender, every recipient including bcc, subject, whether it is ' +
        'threaded onto a conversation, the first 500 characters of the body, and every attached file with ' +
        'its blobId. Use this to confirm what was staged before sending — especially for a draft you did ' +
        'not write yourself — and to get the blobIds update_draft needs to keep those files when it ' +
        'replaces the attachment list. For messages that have already been sent or received, use get_email.',
      inputSchema: getDraftInput,
      title: 'Get draft',
    },
    (args) => {
      const parsed = getDraftInput.parse(args)
      return getDraft(deps, { args: parsed, token: getToken() })
    }
  )
}
