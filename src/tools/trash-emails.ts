// trash_emails tool — move messages to the Trash mailbox (wholesale
// replacement of the mailbox set, like move_emails). Recoverable from
// the mail client until Trash is emptied, but a client gating on
// destructiveHint should still confirm it, so it is its own tool rather than
// a destination move_emails accepts. Permanent deletion (Email/set destroy)
// is deliberately not exposed.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { type FileEmailsDeps, formatBatchResult, idsInput, idsShape } from './file-emails-common.ts'
import { errorResult, type ToolResult } from './result.ts'

export interface TrashEmailsContext {
  args: { ids: string[] }
  token: string
}

export const trashEmails = async (deps: FileEmailsDeps, ctx: TrashEmailsContext): Promise<ToolResult> => {
  const places = await deps.resolvePlaces(ctx.token)
  if (!places.trash) {
    return errorResult('This account has no Trash mailbox, so messages cannot be trashed. Nothing was changed.')
  }
  const result = await deps.replaceMailboxes(ctx.token, ctx.args.ids, places.trash)
  return formatBatchResult('Trashed', result)
}

// --- MCP registration ----------------------------------------------------

export const registerTrashEmails = (server: McpServer, deps: FileEmailsDeps, getToken: () => string): void => {
  server.registerTool(
    'trash_emails',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Move one or more messages to the Trash. Use this only when the user asks to delete, trash, ' +
        'or bin mail; to clear the inbox without deleting, use archive_emails, and to file into a ' +
        'folder use move_emails. Trashed messages stay recoverable in the mail client until Trash ' +
        'is emptied; there is no permanent delete. Takes message ids from search_emails or ' +
        'get_thread. Reports how many messages were trashed and lists any id the server refused.',
      inputSchema: idsShape,
      title: 'Trash emails',
    },
    (args) => trashEmails(deps, { args: idsInput.parse(args), token: getToken() })
  )
}
