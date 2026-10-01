// mark_emails tool — set the read state of messages. One targeted keyword
// patch ($seen add or drop) over the whole batch, so nothing else about a
// message — its folders, its tags, its flag — moves. Reading a message with
// get_email never changes its read state; the agent decides, through this.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ACCOUNT_WRITE } from './annotations.ts'
import { dedupedIds, type FileEmailsDeps, formatBatchResult, idsShape } from './file-emails-common.ts'
import { type ToolResult } from './result.ts'

// RFC 8621 §4.1.1: the system keyword for "this message has been read".
const SEEN_KEYWORD = '$seen'

const markEmailsShape = {
  ...idsShape,
  as: z.enum(['read', 'unread']).describe('"read" marks the messages as read; "unread" marks them unread again.'),
}

export const markEmailsInput = z.object({ ...markEmailsShape, ids: dedupedIds })

export type MarkEmailsArgs = z.infer<typeof markEmailsInput>

export interface MarkEmailsContext {
  args: MarkEmailsArgs
  token: string
}

export const markEmails = async (deps: FileEmailsDeps, ctx: MarkEmailsContext): Promise<ToolResult> => {
  const read = ctx.args.as === 'read'
  const result = await deps.updateEmails(ctx.token, ctx.args.ids, { keywords: { [SEEN_KEYWORD]: read } })
  return formatBatchResult('Marked', result, ` as ${ctx.args.as}`)
}

// --- MCP registration ----------------------------------------------------

export const registerMarkEmails = (server: McpServer, deps: FileEmailsDeps, getToken: () => string): void => {
  server.registerTool(
    'mark_emails',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Mark one or more messages as read or unread. Reading a message with get_email, get_thread or ' +
        'search_emails never changes its read state, so call this when the user wants what you read ' +
        'marked read, or says "keep this unread" / "mark it unread". Takes message ids from ' +
        'search_emails or get_thread; folders, tags and flags are untouched, and re-running it on the ' +
        'same ids is harmless. To get a message out of the inbox use archive_emails or move_emails ' +
        'instead; to mark something as spam, use move_emails with Junk. ' +
        'Reports how many messages were marked and lists any id the server refused.',
      inputSchema: markEmailsShape,
      title: 'Mark emails read or unread',
    },
    (args) => markEmails(deps, { args: markEmailsInput.parse(args), token: getToken() })
  )
}
