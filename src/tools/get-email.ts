// get_email tool — fetch a single message's full detail (recipients plus
// plain-text body) by id. search_emails deliberately omits bodies; the agent
// opens a specific hit with this tool.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type EmailDetailRecord, type EmailGetDetailParams, emailGetDetail, type JmapLive } from '@langmail/jmap'

import { emailTags, formatAddressList } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// Cap the body we pull back so a huge newsletter can't blow the token budget;
// Stalwart truncates the value at this byte count.
const MAX_BODY_VALUE_BYTES = 100_000

const getEmailShape = {
  id: z.string().min(1).describe('The message id, as returned by search_emails or get_thread.'),
}

export const getEmailInput = z.object(getEmailShape)

export type GetEmailArgs = z.infer<typeof getEmailInput>

export interface GetEmailDeps {
  emailGetDetail: (p: EmailGetDetailParams) => Promise<EmailDetailRecord[]>
  resolveAccountId: (token: string) => Promise<string>
}

export interface GetEmailContext {
  args: GetEmailArgs
  token: string
}

// Concatenate the text/plain body parts, resolving each part's fetched value.
// HTML-only messages fall back to Stalwart's server-side textBody resolution.
const bodyText = (e: EmailDetailRecord): string => {
  const values = e.bodyValues ?? {}
  return (e.textBody ?? [])
    .map((part) => (part.partId ? (values[part.partId]?.value ?? '') : ''))
    .filter((v) => v.length > 0)
    .join('\n')
    .trim()
}

export const getEmail = async (deps: GetEmailDeps, ctx: GetEmailContext): Promise<ToolResult> => {
  const { token, args } = ctx
  const accountId = await deps.resolveAccountId(token)
  const [email] = await deps.emailGetDetail({
    accountId,
    apiUrl: '',
    ids: [args.id],
    maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
    token,
  })
  if (!email) {
    return errorResult(`Email not found: ${args.id}`)
  }

  const header = [
    `Subject: ${email.subject ?? '(no subject)'}`,
    `From: ${formatAddressList(email.from) || '(unknown sender)'}`,
    `To: ${formatAddressList(email.to) || '(none)'}`,
  ]
  const cc = formatAddressList(email.cc)
  if (cc) {
    header.push(`Cc: ${cc}`)
  }
  header.push(`Date: ${email.receivedAt ?? ''}`)
  const tags = emailTags(email)
  if (tags.length > 0) {
    header.push(`Tags: ${tags.join(', ')}`)
  }
  const body = bodyText(email) || '(no text body)'
  return textResult(`${header.join('\n')}\n\n${body}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive): GetEmailDeps => ({
  emailGetDetail: async (p) => emailGetDetail({ ...p, apiUrl: (await live.getSession(p.token)).apiUrl }),
  resolveAccountId: live.resolveAccountId,
})

// --- MCP registration ----------------------------------------------------

export const registerGetEmail = (server: McpServer, deps: GetEmailDeps, getToken: () => string): void => {
  server.registerTool(
    'get_email',
    {
      description:
        "Fetch a single message's recipients and plain-text body by id. Use the " +
        'id returned by search_emails or get_thread.',
      inputSchema: getEmailShape,
      title: 'Get email',
    },
    (args) => {
      const parsed = getEmailInput.parse(args)
      return getEmail(deps, { args: parsed, token: getToken() })
    }
  )
}
