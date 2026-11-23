// archive_emails tool — take messages out of the places mail waits in before
// it is handled (Inbox, Junk, Trash) and into the Archive mailbox. Add-Archive
// + drop-those-three rather than a wholesale replacement so a message that also
// lives in Sent (your own reply in a thread) or in a user folder stays there.
// Junk and Trash are dropped too, or a message archived out of Junk would sit
// in both folders. The rules engine's `archive` action still drops only the
// Inbox.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

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
  // JMAP accepts `false` for a mailbox the message is not in, so one patch
  // serves every id without reading where each one is first.
  const mailboxIds: Record<string, boolean> = { [places.archive]: true }
  for (const left of [places.inbox, places.junk, places.trash]) {
    if (left && left !== places.archive) {
      mailboxIds[left] = false
    }
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
        'Archive one or more messages: take them out of the Inbox, Junk and Trash and file them in the ' +
        'Archive mailbox; Sent and any other folder they are in stay as they are. Use this when the user ' +
        'says archive, clear, or "get this out of my inbox". ' +
        'Read state and flags (to-do, starred) are untouched (use mark_emails for those), and ' +
        're-running it on the same ids is harmless. Takes message ids ' +
        "from search_emails or get_thread; pass all of a thread's ids to archive the conversation. " +
        'To file into a specific folder use move_emails; to delete use trash_emails. Reports how ' +
        'many messages were archived and lists any id the server refused.',
      inputSchema: z.object(idsShape),
      title: 'Archive emails',
    },
    (args) => archiveEmails(deps, { args: idsInput.parse(args), token: getToken() })
  )
}
