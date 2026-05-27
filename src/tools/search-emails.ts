// search_emails tool — full-text search over the authenticated user's
// mailbox, returning subject/sender/date/preview.
//
// The tool logic lives behind a `Deps` interface so it can be unit-
// tested without spinning up Stalwart. `registerSearchEmails(server)`
// wires the live deps into the MCP server.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { EmailGetParams, EmailQueryParams } from '../jmap/email.ts'
import { emailGet, emailQuery, mailboxIdByName } from '../jmap/email.ts'
import { accountIdForMail, fetchSession } from '../jmap/session.ts'
import type { SessionCache } from '../jmap/session-cache.ts'
import type { EmailRecord } from '../jmap/types.ts'

export const searchEmailsInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  mailbox: z.string().optional(),
  query: z.string().min(1).max(500),
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

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

const formatEmail = (idx: number, e: EmailRecord): string => {
  const subject = e.subject ?? '(no subject)'
  const from = e.from?.map((f) => (f.name ? `${f.name} <${f.email}>` : f.email)).join(', ') ?? '(unknown sender)'
  const date = e.receivedAt ?? ''
  return `${idx}. ${subject}\n   from: ${from}\n   date: ${date}`
}

export const searchEmails = async (deps: SearchEmailsDeps, ctx: SearchEmailsContext): Promise<ToolResult> => {
  const { token, args } = ctx
  const accountId = await deps.resolveAccountId(token)

  let mailboxId: string | undefined
  if (args.mailbox) {
    const id = await deps.resolveMailbox(token, args.mailbox)
    if (!id) {
      return {
        content: [
          {
            text: `Mailbox not found: ${args.mailbox}`,
            type: 'text',
          },
        ],
        isError: true,
      }
    }
    mailboxId = id
  }

  const ids = await deps.emailQuery({
    accountId,
    // wired by live deps; mock deps ignore
    apiUrl: '',
    limit: args.limit,
    text: args.query,
    token,
    ...(mailboxId ? { mailboxId } : {}),
  })

  if (ids.length === 0) {
    return {
      content: [{ text: 'No messages matched.', type: 'text' }],
    }
  }

  const list = await deps.emailGet({
    accountId,
    apiUrl: '',
    ids,
    token,
  })

  const lines = list.map((e, i) => formatEmail(i + 1, e))
  return {
    content: [
      {
        text: `${list.length} message(s) matched:\n\n${lines.join('\n\n')}`,
        type: 'text',
      },
    ],
  }
}

// --- live-deps wiring ----------------------------------------------------

export interface LiveDepsConfig {
  sessionCache?: SessionCache
  stalwartUrl: string
}

export const makeLiveDeps = (cfg: LiveDepsConfig): SearchEmailsDeps => {
  // Principal-keyed session cache lookup needs the principal; without
  // it we cache by token, which is fine for a single process. Cheaper
  // than re-deriving the principal from another userinfo call.
  const sessionByToken = new Map<string, Awaited<ReturnType<typeof fetchSession>>>()

  const getSession = async (token: string) => {
    const hit = sessionByToken.get(token)
    if (hit) {
      return hit
    }
    const session = await fetchSession(cfg.stalwartUrl, token)
    sessionByToken.set(token, session)
    return session
  }

  return {
    emailGet: async (p) => {
      const s = await getSession(p.token)
      return emailGet({ ...p, apiUrl: s.apiUrl })
    },
    emailQuery: async (p) => {
      const s = await getSession(p.token)
      return emailQuery({ ...p, apiUrl: s.apiUrl })
    },
    resolveAccountId: async (token) => accountIdForMail(await getSession(token)),
    resolveMailbox: async (token, name) => {
      const s = await getSession(token)
      return mailboxIdByName({
        accountId: accountIdForMail(s),
        apiUrl: s.apiUrl,
        name,
        token,
      })
    },
  }
}

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
        "Full-text search over the authenticated user's mailbox. " +
        'Returns matching messages with subject, sender, date, and a short preview.',
      inputSchema: searchEmailsInput.shape,
      title: 'Search emails',
    },
    (args) => {
      const parsed = searchEmailsInput.parse(args)
      return searchEmails(deps, { args: parsed, token: getToken() })
    }
  )
}
