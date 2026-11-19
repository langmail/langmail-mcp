// merge_contacts tool — folds duplicate contact cards into the one to keep.
//
// Collection mints one card per sending address, so one organization (a gym
// writing from its own address and from its booking platform) can end up as
// several. Rebuilding that by hand — remove the address here, add it there,
// delete the rest — takes four calls, loses the history and can silently
// change which address mail goes to. This tool does it in one write.
//
// The merged addresses become addresses of the kept card. That is all the
// memory a merge needs: collection finds the card holding an address, so a
// later message from any of them updates the kept card. The update and the
// destroys go out in one ContactCard/set, so a CardDAV device syncs one
// change, never a half-merged book.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { mergeCards } from '../contacts/index.ts'
import { type ContactCard } from '../jmap/index.ts'
import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { type ContactWriteDeps, collectedBookIdOf, contactCtx, contactIdSchema, readBack } from './contact-common.ts'
import { renderContact } from './contact-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'
import { type ContactHydrationDeps, renderDetailedContact } from './search-contacts.ts'

const mergeContactsShape = {
  contactId: contactIdSchema.describe(
    'The contact to keep, as printed by search_contacts under `contact_id`. Its name, organization and birthday win.'
  ),
  mergeContactIds: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe(
      'The contacts to fold into it and then delete, as printed by search_contacts under `contact_id`. Up to 10.'
    ),
  preferredEmail: z
    .email()
    .optional()
    .describe(
      'The address mail to this contact should go to, from any of the merged contacts. ' +
        'Omit it to keep the preferred address the kept contact has now.'
    ),
}

export const mergeContactsInput = z.object(mergeContactsShape)

export type MergeContactsArgs = z.infer<typeof mergeContactsInput>

export type MergeContactsDeps = ContactWriteDeps & ContactHydrationDeps

// SetError types worth a sentence; anything else is named as the server
// sent it.
const reasonFor = (type: string): string =>
  type === 'forbidden' ? 'its address book is read-only' : `the server answered ${type}`

const PREFERRED_NOTE = {
  pinned: 'kept from before the merge and now marked as preferred',
  requested: 'as requested',
  unchanged: 'unchanged',
} as const

export const mergeContacts = async (
  deps: MergeContactsDeps,
  cx: { args: MergeContactsArgs; token: string }
): Promise<ToolResult> => {
  const { args } = cx
  const mergeIds = [...new Set(args.mergeContactIds)]
  if (mergeIds.includes(args.contactId)) {
    return errorResult(
      `${args.contactId} is the contact to keep and cannot also be merged into itself. Nothing was changed. ` +
        'List only the other contacts in mergeContactIds.'
    )
  }
  const ctx = await contactCtx(deps, cx.token)
  const cards = await deps.contactCardGet({ ...ctx, ids: [args.contactId, ...mergeIds] })
  const byId = new Map(cards.map((c) => [c.id, c]))
  const missing = [args.contactId, ...mergeIds].filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return errorResult(
      `No contact with id ${missing.join(', ')}. Nothing was changed. ` +
        'Use search_contacts to find the people and read their contact_id.'
    )
  }
  const kept = byId.get(args.contactId) as ContactCard
  const merged = mergeIds.map((id) => byId.get(id) as ContactCard)

  const merge = mergeCards(kept, merged, args.preferredEmail)
  if ('error' in merge) {
    return errorResult(`${merge.error} Nothing was changed. Name one of those as preferredEmail, or omit it.`)
  }

  // Read before the write, so a failed lookup can never fail a merge that
  // already landed.
  const collectedBookId = await collectedBookIdOf(deps, ctx)
  const details = (ids: string[]): string =>
    merged
      .filter((card) => ids.includes(card.id))
      .map((card) => renderContact(card, collectedBookId))
      .join('\n\n')
  const outcome = await deps.contactCardMerge({ ...ctx, cardId: kept.id, destroy: mergeIds, patch: merge.patch })

  if (outcome.updateError !== undefined) {
    if (outcome.destroyed.length === 0) {
      return errorResult(
        `Could not update the contact to keep: ${reasonFor(outcome.updateError)}. Nothing was changed.`
      )
    }
    // A /set is not atomic: the destroys can land although the update did
    // not. The details below are all that is left of those cards.
    return errorResult(
      `Could not update the contact to keep (${reasonFor(outcome.updateError)}), but the server deleted ` +
        `${outcome.destroyed.join(', ')}. Recreate them with create_contact from these details:\n\n${details(outcome.destroyed)}`
    )
  }

  // Best-effort: the merge already landed and the cards are gone, so a failed
  // read must not swallow the recovery details below.
  const stored = await readBack(deps, ctx, kept.id).catch(() => undefined)
  const rendered = stored
    ? `into this one:\n\n${await renderDetailedContact(
        deps,
        { authorization: ctx.authorization, token: cx.token },
        stored,
        collectedBookId
      )}`
    : `into contact ${kept.id}; reading it back failed, so look it up with search_contacts.`
  // The addresses and history of every listed card landed, deleted or not.
  const deleted = outcome.destroyed.length === mergeIds.length ? '' : ` (${outcome.destroyed.length} deleted)`
  const sections = [`Merged ${mergeIds.length} contact(s)${deleted} ${rendered}`]
  if (merge.preferred) {
    sections.push(`Preferred address: ${merge.preferred.address}, ${PREFERRED_NOTE[merge.preferred.how]}.`)
  }
  if (merge.conflicts.length > 0) {
    sections.push(`Conflicts (the kept contact's value stays):\n${merge.conflicts.map((c) => `- ${c}`).join('\n')}`)
  }
  const failed = Object.entries(outcome.notDestroyed)
  if (failed.length > 0) {
    sections.push(
      `Not deleted: ${failed.map(([id, type]) => `${id} (${reasonFor(type)})`).join(', ')}. ` +
        'Their addresses are now on the kept contact as well; to finish, run merge_contacts again with ' +
        `mergeContactIds: [${failed.map(([id]) => `"${id}"`).join(', ')}] only — their history is not counted twice.`
    )
  }
  if (outcome.destroyed.length > 0) {
    sections.push(`Removed contacts:\n\n${details(outcome.destroyed)}`)
  }
  const moved = merge.movedEmails.length > 0 ? merge.movedEmails.join(', ') : 'none'
  sections.push(
    `Moved addresses: ${moved}. To undo the merge, remove those from the kept contact with update_contact ` +
      '(`removedEmails`), then recreate each removed contact with create_contact from its details above. ' +
      'Later mail from any merged address updates the kept contact. ' +
      'The merge syncs to every device connected over CardDAV as one change.'
  )
  return textResult(sections.join('\n\n'))
}

// --- MCP registration ----------------------------------------------------

export const registerMergeContacts = (server: McpServer, deps: MergeContactsDeps, getToken: () => string): void => {
  server.registerTool(
    'merge_contacts',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Merge duplicate contacts — the same person or organization collected under several addresses — ' +
        'into the one to keep, and delete the others. The kept contact gains every email address, phone ' +
        'number, postal address and note of the merged ones and their interaction history; its name, ' +
        'organization, birthday and preferred address stay unless it has none, and every value that does ' +
        'not fit is listed as a conflict. Later mail from any merged address updates the kept contact. ' +
        'Returns the merged contact in the detailed search_contacts format plus the full details of the ' +
        'removed contacts, which is what undoing it by hand needs. Find the ids with search_contacts; to ' +
        'move a single address between two contacts that are different people, use update_contact instead, ' +
        'and to drop a contact without keeping anything, delete_contact.',
      inputSchema: mergeContactsInput,
      title: 'Merge contacts',
    },
    (args) => mergeContacts(deps, { args: mergeContactsInput.parse(args), token: getToken() })
  )
}
