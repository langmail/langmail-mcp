// get_thread tool — list every message in the same thread as a given message
// id, oldest-first, in the lightweight search-result shape. Bodies are fetched
// per-message via get_email.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  bearerAuthorization,
  type EmailGetParams,
  type EmailRecord,
  emailGet,
  type JmapLive,
  type ThreadEmailIdsParams,
  threadEmailIds,
} from '@langmail/jmap'

import { formatEmailLine, orderById } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const getThreadShape = {
  id: z.string().min(1).describe('A message id; every message in its thread is returned.'),
}

export const getThreadInput = z.object(getThreadShape)

export type GetThreadArgs = z.infer<typeof getThreadInput>

export interface GetThreadDeps {
  emailGet: (p: EmailGetParams) => Promise<EmailRecord[]>
  resolveAccountId: (authorization: string) => Promise<string>
  threadEmailIds: (p: ThreadEmailIdsParams) => Promise<string[]>
}

export interface GetThreadContext {
  args: GetThreadArgs
  token: string
}

export const getThread = async (deps: GetThreadDeps, ctx: GetThreadContext): Promise<ToolResult> => {
  const { token, args } = ctx
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)
  const ids = await deps.threadEmailIds({ accountId, apiUrl: '', authorization, emailId: args.id })
  if (ids.length === 0) {
    return errorResult(`Thread not found for message: ${args.id}`)
  }

  const list = await deps.emailGet({ accountId, apiUrl: '', authorization, ids })
  // Restore Thread/get's chronological (oldest-first) order and mark the
  // message the caller asked about.
  const ordered = orderById(ids, list)
  const lines = ordered.map((e, i) => formatEmailLine(i + 1, e, { requested: e.id === args.id }))
  return textResult(`${ordered.length} message(s) in thread:\n\n${lines.join('\n\n')}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive): GetThreadDeps => ({
  emailGet: async (p) => emailGet({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  resolveAccountId: live.resolveAccountId,
  threadEmailIds: async (p) => threadEmailIds({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
})

// --- MCP registration ----------------------------------------------------

export const registerGetThread = (server: McpServer, deps: GetThreadDeps, getToken: () => string): void => {
  server.registerTool(
    'get_thread',
    {
      description:
        'List every message in the same thread as a given message id, oldest-first ' +
        '(id, subject, sender, date, tags). Fetch a body with get_email.',
      inputSchema: getThreadShape,
      title: 'Get thread',
    },
    (args) => {
      const parsed = getThreadInput.parse(args)
      return getThread(deps, { args: parsed, token: getToken() })
    }
  )
}
