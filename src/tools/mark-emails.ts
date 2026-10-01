// mark_emails tool — set and clear the user-facing flags on messages: read,
// to-do, starred. One targeted keyword patch over the whole batch, so nothing
// else about a message — its folders, its type, any flag left out — moves.
// One field per flag, holding the state the flag should end up in, so "add
// and remove the same flag" cannot be expressed. Reading a message with
// get_email never changes its read state; the agent decides, through this.
// System flags ($answered, $draft) and classification types are deliberately
// not fields: an agent must not fake what happened to a message.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ACCOUNT_WRITE } from './annotations.ts'
import { dedupedIds, type FileEmailsDeps, formatBatchResult, idsShape } from './file-emails-common.ts'
import { keywordToJmapKeyword } from './keywords.ts'
import { errorResult, type ToolResult } from './result.ts'

// RFC 8621 §4.1.1 system keywords: "has been read" and "flagged for urgent or
// special attention" — the keyword Gmail's STARRED and the mail-rule flag
// action already map to.
const SEEN_KEYWORD = '$seen'
const FLAGGED_KEYWORD = '$flagged'
// The same `$label:todo` keyword search_emails filters on with keywords: ["todo"].
const TODO_KEYWORD = keywordToJmapKeyword('todo')

const markEmailsShape = {
  ...idsShape,
  read: z
    .boolean()
    .optional()
    .describe('true marks the messages read, false marks them unread. Leave out to keep read state.'),
  starred: z.boolean().optional().describe('true stars the messages, false removes the star. Leave out to keep it.'),
  todo: z
    .boolean()
    .optional()
    .describe(
      'true flags the messages as a to-do for the user, false clears the to-do (e.g. once it is done). ' +
        'Leave out to keep it.'
    ),
}

export const markEmailsInput = z.object({ ...markEmailsShape, ids: dedupedIds })

export type MarkEmailsArgs = z.infer<typeof markEmailsInput>

// Only the keyword patch: mark_emails never resolves or replaces mailboxes.
export type MarkEmailsDeps = Pick<FileEmailsDeps, 'updateEmails'>

export interface MarkEmailsContext {
  args: MarkEmailsArgs
  token: string
}

interface FlagSpec {
  keyword: string
  off: string
  on: string
}

// Field order here is the order the result line names the flags in.
const FLAGS = {
  read: { keyword: SEEN_KEYWORD, off: 'unread', on: 'read' },
  todo: { keyword: TODO_KEYWORD, off: 'not to-do', on: 'to-do' },
  starred: { keyword: FLAGGED_KEYWORD, off: 'unstarred', on: 'starred' },
} as const satisfies Record<Exclude<keyof MarkEmailsArgs, 'ids'>, FlagSpec>

export const markEmails = async (deps: MarkEmailsDeps, ctx: MarkEmailsContext): Promise<ToolResult> => {
  const keywords: Record<string, boolean> = {}
  const labels: string[] = []
  for (const [field, spec] of Object.entries(FLAGS)) {
    const value = ctx.args[field as keyof typeof FLAGS]
    if (value === undefined) {
      continue
    }
    keywords[spec.keyword] = value
    labels.push(value ? spec.on : spec.off)
  }
  if (labels.length === 0) {
    const fields = Object.keys(FLAGS)
    const choices = `${fields.slice(0, -1).join(', ')} or ${fields.at(-1)}`
    return errorResult(`No flag given, so nothing was changed. Pass at least one of ${choices}.`)
  }
  const result = await deps.updateEmails(ctx.token, ctx.args.ids, { keywords })
  return formatBatchResult('Marked', result, ` as ${labels.join(', ')}`)
}

// --- MCP registration ----------------------------------------------------

export const registerMarkEmails = (server: McpServer, deps: FileEmailsDeps, getToken: () => string): void => {
  server.registerTool(
    'mark_emails',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Set or clear the flags on one or more messages: read / unread, to-do, and starred. ' +
        'Reading a message with get_email, get_thread or search_emails never changes its read state, so ' +
        'call this when the user wants what you read marked read or says "keep this unread"; set todo when ' +
        'a message needs action from the user ("flag this for me", "add it to my to-dos"), clear it when ' +
        'the to-do is done ("mark it done"), and set starred for "star this". Several flags go in one call; ' +
        'a flag you leave out is untouched. To finish a to-do, call this tool with todo: false (plus ' +
        'read: true if it is still unread), then archive_emails. Takes message ids from search_emails or ' +
        'get_thread; folders are untouched, and re-running it on the same ids is harmless. To get a ' +
        'message out of the inbox use archive_emails or move_emails instead; to mark something as spam, ' +
        'use move_emails with Junk. Reports how many messages were marked and lists any id the server refused.',
      inputSchema: markEmailsShape,
      title: 'Mark emails read, to-do or starred',
    },
    (args) => markEmails(deps, { args: markEmailsInput.parse(args), token: getToken() })
  )
}
