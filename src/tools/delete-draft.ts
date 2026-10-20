// delete_draft tool — retire a staged draft for good.
//
// A hard destroy, not a move to Trash. A trashed draft keeps `$draft`, so it
// would still read as a draft that was discarded rather than one that is gone,
// and update_draft already destroys every revision it replaces in the same way.
// This is the one permanent deletion on the mail surface, and it is fenced to
// unsent drafts: a message without `$draft` — sent or received mail — is
// refused whatever id is passed.
//
// The destroy runs under the send reservation (drafts/send-guard.ts), taken on
// both ids the draft answers to, exactly as send_draft takes it. Destroying a
// message while its submission is in flight, or after a send whose outcome was
// lost, would leave nobody able to tell whether it went out. The reservation
// only fences sends through this process: a send from another client landing
// between the check and the destroy is not, and is accepted as unlikely.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization } from '@langmail/jmap'

import { holdSend, type SendGuard, type SendHold } from '../drafts/send-guard.ts'
import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { type DraftToolDeps, isDraft, loadDraft, stableDraftId } from './draft-common.ts'
import { formatAddressList } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'
import { sendDraftSubject } from './send-draft.ts'

export const deleteDraftInput = z.object({
  draftId: z
    .string()
    .min(1)
    .describe(
      'The draft id, as returned by create_draft or update_draft — edits do not change it — or a message id ' +
        'from search_emails with `mailbox: "Drafts"`, which an edit replaces with the draftId it returns.'
    ),
})

export type DeleteDraftArgs = z.infer<typeof deleteDraftInput>

export interface DeleteDraftContext {
  args: DeleteDraftArgs
  principal: string
  token: string
}

// Why the destroy is off while a send of the draft holds the reservation.
const sendPendingRefusal = (draftId: string): string =>
  `A send of ${draftId} is in progress or may already have gone out, so it was not deleted. Nothing was ` +
  "deleted. Read it back with get_email, or check the user's Sent folder, before deciding."

export const deleteDraft = async (
  deps: DraftToolDeps,
  guard: SendGuard,
  ctx: DeleteDraftContext
): Promise<ToolResult> => {
  const taken = holdSend(guard, ctx.principal, sendDraftSubject(ctx.args.draftId))
  if ('refused' in taken) {
    return errorResult(sendPendingRefusal(ctx.args.draftId))
  }
  try {
    return await deleteHeld(deps, taken.hold, ctx)
  } finally {
    taken.hold.end()
  }
}

const deleteHeld = async (deps: DraftToolDeps, hold: SendHold, ctx: DeleteDraftContext): Promise<ToolResult> => {
  const { draftId } = ctx.args
  const authorization = bearerAuthorization(ctx.token)
  const accountId = await deps.resolveAccountId(authorization)
  const record = await loadDraft(deps, { accountId, authorization, draftId })
  if (!record) {
    return errorResult(
      `Draft not found: ${draftId}. Nothing was deleted. Find it with search_emails using mailbox "Drafts".`
    )
  }
  if (!isDraft(record)) {
    return errorResult(
      `${draftId} is not a draft — it has already been sent or received, and only unsent drafts can be ` +
        `deleted. Nothing was deleted. Read it with get_email, passing id ${record.id}.`
    )
  }
  // The other id this draft answers to — a send through it must block the
  // destroy just the same.
  for (const alias of new Set([record.id, stableDraftId(record)])) {
    if (alias !== null && alias !== draftId && hold.cover(sendDraftSubject(alias))) {
      return errorResult(sendPendingRefusal(draftId))
    }
  }

  const outcome = await deps.draftDestroy({ accountId, apiUrl: '', authorization, id: record.id })
  if ('notDestroyed' in outcome) {
    return errorResult(
      outcome.notDestroyed === 'notFound'
        ? `Draft not found: ${draftId} — it was removed before this call reached it. Nothing was deleted.`
        : `The server refused to delete ${draftId} (${outcome.notDestroyed}). Nothing was deleted.`
    )
  }
  const recipients = formatAddressList(record.to) || 'no recipients'
  return textResult(
    `Deleted draft ${draftId} ("${record.subject || '(no subject)'}", to ${recipients}). It cannot be recovered.`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerDeleteDraft = (
  server: McpServer,
  deps: DraftToolDeps,
  guard: SendGuard,
  getToken: () => string,
  getPrincipal: () => string
): void => {
  server.registerTool(
    'delete_draft',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Permanently delete an unsent draft. Use this to retire a draft that is no longer wanted — for ' +
        'example the earlier version after you staged a replacement with create_draft — so the user does ' +
        'not find duplicates in their Drafts folder. Takes the draftId create_draft or update_draft ' +
        'returned, or a message id search_emails shows in Drafts. The draft does not go to Trash and cannot ' +
        'be recovered; to change a draft rather than remove it, use update_draft. Sent or received mail is ' +
        'refused (use trash_emails for that), as is a draft whose send is in progress. Returns the deleted ' +
        "draft's subject and recipients.",
      inputSchema: deleteDraftInput.shape,
      title: 'Delete draft',
    },
    (args) => {
      const parsed = deleteDraftInput.parse(args)
      return deleteDraft(deps, guard, { args: parsed, principal: getPrincipal(), token: getToken() })
    }
  )
}
