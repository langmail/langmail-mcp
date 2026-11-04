// delete_contact tool — removes a contact card from the account.
//
// Deletion means different things depending on where the record came from,
// and the tool says so rather than pretending otherwise. An `authored` or
// `imported` card is gone for good, from the account and from every device
// syncing it over CardDAV. A `derived` card is only gone until the next
// message or calendar invitation from that person rebuilds it — the
// collection pipeline has no memory of a deletion, so this is a reset, not a
// suppression. Suppressing a person permanently is a different operation
// (a block list) that this surface does not have yet, and calling that out
// in the result is more useful than refusing the call.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { sourceOf } from '@langmail/contacts'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { type ContactWriteDeps, contactCtx, contactIdSchema } from './contact-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const deleteContactShape = {
  contactId: contactIdSchema,
}

export const deleteContactInput = z.object(deleteContactShape)

export type DeleteContactArgs = z.infer<typeof deleteContactInput>

const AFTERMATH = {
  authored:
    'It was authored here, so nothing will bring it back — recreate it with create_contact if that was a mistake.',
  derived:
    'It was derived from mail headers and calendar attendees, so the next message or invitation from this person ' +
    'will collect them again. There is no way to suppress a person permanently on this surface yet.',
  imported:
    'It came from an address book on the account rather than from collection, so it will not come back on its own.',
} as const

export const deleteContact = async (
  deps: ContactWriteDeps,
  cx: { args: DeleteContactArgs; token: string }
): Promise<ToolResult> => {
  const ctx = await contactCtx(deps, cx.token)
  const [card] = await deps.contactCardGet({ ...ctx, ids: [cx.args.contactId] })
  if (!card) {
    return errorResult(
      `No contact with id ${cx.args.contactId}. Use search_contacts to find the person and read their contact_id.`
    )
  }
  const label = card.name?.full ?? Object.values(card.emails ?? {})[0]?.address ?? cx.args.contactId
  const source = sourceOf(card)

  await deps.contactCardDestroy({ ...ctx, cardId: cx.args.contactId })

  return textResult(
    `Deleted the contact "${label}" (contact_id: ${cx.args.contactId}). ${AFTERMATH[source]} ` +
      'The deletion syncs to every device connected over CardDAV.'
  )
}

// --- MCP registration ----------------------------------------------------

export const registerDeleteContact = (server: McpServer, deps: ContactWriteDeps, getToken: () => string): void => {
  server.registerTool(
    'delete_contact',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Delete a contact by id, removing it from the account and from every device syncing ' +
        'the address book. A contact derived from mail headers or calendar attendees is only ' +
        'removed until the next message from that person recreates it — to drop one field ' +
        'instead of the whole record, use update_contact. Find the id with search_contacts.',
      inputSchema: z.object(deleteContactShape),
      title: 'Delete contact',
    },
    (args) => deleteContact(deps, { args: deleteContactInput.parse(args), token: getToken() })
  )
}
