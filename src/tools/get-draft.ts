// get_draft tool — read a staged draft back exactly as it will be sent.
//
// get_email deliberately can't do this job: it renders a message through the
// langmail cleaning pipeline (markdown out, whatever the sender put in) and
// never shows `bcc`, because a received message has none. A draft needs the
// literal staged fields — blind-copied recipients included — or the agent can't
// report what it actually staged and update_draft can't merge onto it.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization } from '@langmail/jmap'

import { READ_ONLY } from './annotations.ts'
import {
  type DraftToolDeps,
  draftFromRecord,
  formatDraft,
  isDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
} from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

export const getDraftInput = z.object({
  draftId: z.string().min(1).describe('The draft id, as returned by create_draft or update_draft.'),
})

export type GetDraftArgs = z.infer<typeof getDraftInput>

export interface GetDraftContext {
  args: GetDraftArgs
  token: string
}

export const getDraft = async (deps: DraftToolDeps, ctx: GetDraftContext): Promise<ToolResult> => {
  const authorization = bearerAuthorization(ctx.token)
  const accountId = await deps.resolveAccountId(authorization)
  const record = await deps.emailComposeGet({
    accountId,
    apiUrl: '',
    authorization,
    id: ctx.args.draftId,
    maxBodyValueBytes: MAX_DRAFT_BODY_VALUE_BYTES,
  })
  if (!record) {
    return errorResult(`Draft not found: ${ctx.args.draftId}`)
  }
  if (!isDraft(record)) {
    return errorResult(
      `${ctx.args.draftId} is not a draft — it has already been sent or received. Read it with get_email instead.`
    )
  }
  return textResult(
    `Draft (not sent):\ndraftId: ${record.id}\n${formatDraft(draftFromRecord(record), { threadId: record.threadId })}`
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
        'threaded onto a conversation, and the first 500 characters of the body. Use this to confirm what ' +
        'was staged before sending — especially for a draft you did not write yourself. For messages that ' +
        'have already been sent or received, use get_email.',
      inputSchema: getDraftInput.shape,
      title: 'Get draft',
    },
    (args) => {
      const parsed = getDraftInput.parse(args)
      return getDraft(deps, { args: parsed, token: getToken() })
    }
  )
}
