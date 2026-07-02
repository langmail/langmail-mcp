// search_emails tool — structured search over the authenticated user's
// mailbox. Supports free-text FTS plus optional date-range, sender, keyword
// (category label), and mailbox filters, returning a token-frugal hit list
// (id/subject/sender/date/tags), newest-first. Bodies are fetched separately
// via get_email.
//
// The tool logic lives behind a `Deps` interface so it can be unit-tested
// without spinning up Stalwart. `makeLiveDeps` wires the live JMAP deps.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type EmailGetParams, type EmailQueryParams, emailGet, emailQuery, mailboxIdByName } from '../jmap/email.ts'
import { type JmapLive } from '../jmap/live.ts'
import { accountIdForMail } from '../jmap/session.ts'
import { type EmailRecord } from '../jmap/types.ts'
import { formatEmailLine, orderById } from './format.ts'
import { KEYWORD_VALUES, KEYWORDS_DESCRIPTION, keywordToJmapLabel } from './keywords.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// Raw shape handed to registerTool (JSON-schema source). The "at least one
// filter" rule can't live here — it's cross-field — so it's a refine on the
// parsing schema below, enforced when the handler parses the args.
const searchEmailsShape = {
  // JMAP filters on UTCDate: the timestamp offset MUST be `Z` (RFC 8620 §1.4),
  // so we require the UTC form rather than allowing arbitrary offsets.
  after: z.iso
    .datetime()
    .optional()
    .describe(
      'Only messages received on/after this UTC ISO-8601 timestamp, e.g. "2026-04-01T00:00:00Z" (start of "last 3 months").'
    ),
  before: z.iso
    .datetime()
    .optional()
    .describe('Only messages received strictly before this UTC ISO-8601 timestamp, e.g. "2026-07-01T00:00:00Z".'),
  from: z.string().min(1).max(200).optional().describe('Substring match on the sender name or address.'),
  keywords: z.array(z.enum(KEYWORD_VALUES)).min(1).optional().describe(KEYWORDS_DESCRIPTION),
  limit: z.number().int().min(1).max(100).default(20),
  mailbox: z.string().optional().describe('Restrict to a named mailbox/folder (e.g. "Inbox").'),
  query: z.string().min(1).max(500).optional().describe('Free-text full-text search over subject and body.'),
}

const hasAnyFilter = (v: {
  after?: string
  before?: string
  from?: string
  keywords?: string[]
  mailbox?: string
  query?: string
}): boolean => Boolean(v.query ?? v.after ?? v.before ?? v.from ?? v.mailbox ?? (v.keywords && v.keywords.length > 0))

export const searchEmailsInput = z.object(searchEmailsShape).refine(hasAnyFilter, {
  message: 'Provide at least one filter: query, after, before, from, keywords, or mailbox.',
})

export type SearchEmailsArgs = z.infer<typeof searchEmailsInput>

export interface SearchEmailsDeps {
  emailGet: (p: EmailGetParams) => Promise<EmailRecord[]>
  emailQuery: (p: EmailQueryParams) => Promise<string[]>
  resolveAccountId: (token: string) => Promise<string>
  resolveMailbox: (token: string, name: string) => Promise<string | null>
}

export interface SearchEmailsContext {
  args: SearchEmailsArgs
  token: string
}

export const searchEmails = async (deps: SearchEmailsDeps, ctx: SearchEmailsContext): Promise<ToolResult> => {
  const { token, args } = ctx
  const accountId = await deps.resolveAccountId(token)

  let mailboxId: string | undefined
  if (args.mailbox) {
    const id = await deps.resolveMailbox(token, args.mailbox)
    if (!id) {
      return errorResult(`Mailbox not found: ${args.mailbox}`)
    }
    mailboxId = id
  }

  const ids = await deps.emailQuery({
    accountId,
    // wired by live deps; mock deps ignore
    apiUrl: '',
    filters: {
      ...(args.query ? { text: args.query } : {}),
      ...(args.after ? { after: args.after } : {}),
      ...(args.before ? { before: args.before } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords.map(keywordToJmapLabel) } : {}),
      ...(mailboxId ? { mailboxId } : {}),
    },
    limit: args.limit,
    token,
  })

  if (ids.length === 0) {
    return textResult('No messages matched.')
  }

  const list = await deps.emailGet({ accountId, apiUrl: '', ids, token })
  // Restore the query's newest-first order so the response reflects the
  // receivedAt-desc sort (Email/get doesn't preserve id order).
  const ordered = orderById(ids, list)
  const lines = ordered.map((e, i) => formatEmailLine(i + 1, e))
  return textResult(`${ordered.length} message(s) matched:\n\n${lines.join('\n\n')}`)
}

// --- live-deps wiring ----------------------------------------------------

// `live` is shared across the JMAP tools (built once in the handler) so a
// bearer's session is resolved once per request cycle, not once per tool.
export const makeLiveDeps = (live: JmapLive): SearchEmailsDeps => ({
  emailGet: async (p) => emailGet({ ...p, apiUrl: (await live.getSession(p.token)).apiUrl }),
  emailQuery: async (p) => emailQuery({ ...p, apiUrl: (await live.getSession(p.token)).apiUrl }),
  resolveAccountId: live.resolveAccountId,
  resolveMailbox: async (token, name) => {
    const s = await live.getSession(token)
    return mailboxIdByName({ accountId: accountIdForMail(s), apiUrl: s.apiUrl, name, token })
  },
})

// --- MCP registration ----------------------------------------------------

export const registerSearchEmails = (
  server: McpServer,
  deps: SearchEmailsDeps,
  // Tools execute outside the request lifecycle, so the bearer must be
  // threaded in via this getter (closed over per request — see
  // mcp/handler.ts).
  getToken: () => string
): void => {
  server.registerTool(
    'search_emails',
    {
      description:
        "Search the authenticated user's mailbox. Combine free-text (query) with " +
        'optional filters: date range (after/before), sender (from), category ' +
        'labels (keywords), and mailbox. At least one filter is required. Returns ' +
        'matching messages newest-first with id, subject, sender, date, and tags. ' +
        'Fetch a full body with get_email.',
      inputSchema: searchEmailsShape,
      title: 'Search emails',
    },
    (args) => {
      // The SDK already validated args against searchEmailsShape, so the only
      // way parsing fails here is the cross-field "at least one filter" refine.
      // Surface it as a clean tool error rather than a raw ZodError blob.
      const parsed = searchEmailsInput.safeParse(args)
      if (!parsed.success) {
        return errorResult('Provide at least one filter: query, after, before, from, keywords, or mailbox.')
      }
      return searchEmails(deps, { args: parsed.data, token: getToken() })
    }
  )
}
