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

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { holdSend, type SendGuard, type SendHold, type SendReservation } from '../drafts/send-guard.ts'
import { bearerAuthorization } from '../jmap/index.ts'
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
      'The draft id, as returned by create_draft, update_draft or list_drafts — edits do not change it — or a ' +
        'message id from search_emails with `mailbox: "Drafts"`, which an edit replaces with the draftId it returns.'
    ),
})

export type DeleteDraftArgs = z.infer<typeof deleteDraftInput>

export interface DeleteDraftContext {
  args: DeleteDraftArgs
  principal: string
  token: string
}

// Why the destroy is off while the draft's send reservation is held. A delete
// reserves in send_draft's key space, so `in_flight` may be another delete and
// must not point at Sent; only a send ever leaves `unknown`.
const reservationRefusal = (draftId: string, held: SendReservation): string =>
  held.state === 'in_flight'
    ? `Another call is already working on ${draftId} — a send, or a delete like this one. Nothing was ` +
      'deleted. Wait for it to finish, then read the draft back with get_draft before retrying.'
    : `An earlier send of ${draftId} failed without saying whether the message went out. Nothing was ` +
      "deleted. Read it back with get_email, or check the user's Sent folder, before deciding."

// Why the server's destroy did not land, by the SetError type it answered with.
const destroyRefusal = (draftId: string, type: string): string => {
  if (type === 'notFound') {
    return `Draft not found: ${draftId} — it was removed before this call reached it. Nothing was deleted.`
  }
  if (type === 'unknown') {
    return `The server did not say whether ${draftId} was deleted. Read it back with get_draft before retrying.`
  }
  return `The server refused to delete ${draftId} (${type}). Nothing was deleted.`
}

export const deleteDraft = async (
  deps: DraftToolDeps,
  guard: SendGuard,
  ctx: DeleteDraftContext
): Promise<ToolResult> => {
  const taken = holdSend(guard, ctx.principal, sendDraftSubject(ctx.args.draftId))
  if ('refused' in taken) {
    return errorResult(reservationRefusal(ctx.args.draftId, taken.refused))
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
    return errorResult(`Draft not found: ${draftId}. Nothing was deleted. Find it with list_drafts.`)
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
    if (alias === null || alias === draftId) {
      continue
    }
    const clash = hold.cover(sendDraftSubject(alias))
    if (clash) {
      return errorResult(reservationRefusal(draftId, clash))
    }
  }

  const outcome = await deps.draftDestroy({ accountId, apiUrl: '', authorization, id: record.id })
  if ('notDestroyed' in outcome) {
    return errorResult(destroyRefusal(draftId, outcome.notDestroyed))
  }
  // Labelled per field, as formatDraft does: a blind-copied address must not
  // read as a visible recipient.
  const fields = [
    ['to', record.to],
    ['cc', record.cc],
    ['bcc', record.bcc],
  ] as const
  const recipients =
    fields
      .flatMap(([label, addresses]) => {
        const formatted = formatAddressList(addresses)
        return formatted ? [`${label} ${formatted}`] : []
      })
      .join('; ') || 'no recipients'
  return textResult(
    `Deleted draft ${draftId} ("${record.subject || '(no subject)'}", ${recipients}). The deleted version cannot be recovered.`
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
        'returned, or one list_drafts shows. The draft does not go to Trash and cannot ' +
        'be recovered; to change a draft rather than remove it, use update_draft. Sent or received mail is ' +
        'refused (use trash_emails for that), as is a draft whose send is in progress. Returns the deleted ' +
        "draft's subject and recipients.",
      inputSchema: deleteDraftInput,
      title: 'Delete draft',
    },
    (args) => {
      const parsed = deleteDraftInput.parse(args)
      return deleteDraft(deps, guard, { args: parsed, principal: getPrincipal(), token: getToken() })
    }
  )
}
