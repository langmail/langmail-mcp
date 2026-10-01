// archive_emails tool — take messages out of the Inbox and into the Archive
// mailbox. Add-Archive + drop-Inbox rather than a wholesale replacement so a
// message that also lives in Sent (your own reply in a thread) stays there;
// this is the same patch the rules engine's `archive` action builds.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ACCOUNT_WRITE } from './annotations.ts'
import { type FileEmailsDeps, formatBatchResult, type IdsArgs, idsInput, idsShape } from './file-emails-common.ts'
import { errorResult, type ToolResult } from './result.ts'

export interface ArchiveEmailsContext {
  args: IdsArgs
  token: string
}

export const archiveEmails = async (deps: FileEmailsDeps, ctx: ArchiveEmailsContext): Promise<ToolResult> => {
  const places = await deps.resolvePlaces(ctx.token)
  if (!places.archive) {
    // Deliberately not created here: a model-driven call must not invent
    // folders. The rules engine creates one on first use of an archive rule.
    return errorResult(
      'This account has no Archive mailbox. Nothing was archived. Create one in the mail client, ' +
        'or use move_emails with an existing folder.'
    )
  }
  const mailboxIds: Record<string, boolean> = { [places.archive]: true }
  if (places.inbox && places.inbox !== places.archive) {
    mailboxIds[places.inbox] = false
  }
  const result = await deps.updateEmails(ctx.token, ctx.args.ids, { mailboxIds })
  return formatBatchResult('Archived', result)
}

// --- MCP registration ----------------------------------------------------

export const registerArchiveEmails = (server: McpServer, deps: FileEmailsDeps, getToken: () => string): void => {
  server.registerTool(
    'archive_emails',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Archive one or more messages: remove them from the Inbox and file them in the Archive ' +
        'mailbox. Use this when the user says archive, clear, or "get this out of my inbox". ' +
        'Read state and flags (to-do, starred) are untouched (use mark_emails for those), and ' +
        're-running it on the same ids is harmless. Takes message ids ' +
        "from search_emails or get_thread; pass all of a thread's ids to archive the conversation. " +
        'To file into a specific folder use move_emails; to delete use trash_emails. Reports how ' +
        'many messages were archived and lists any id the server refused.',
      inputSchema: idsShape,
      title: 'Archive emails',
    },
    (args) => archiveEmails(deps, { args: idsInput.parse(args), token: getToken() })
  )
}
