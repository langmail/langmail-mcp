// download_attachment tool — mint a short-lived capability URL for one
// attachment. The tool result carries only metadata + the URL; the bytes go
// Stalwart → MCP server → the agent's disk via GET /attachments/:token,
// never through the model context. The (emailId, blobId) pair lets us
// verify the blob actually belongs to a message the caller can read and
// recover the canonical filename/type server-side.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  bearerAuthorization,
  type EmailDetailRecord,
  type EmailGetDetailParams,
  emailGetDetail,
  type JmapLive,
} from '@langmail/jmap'

import { TICKET_TTL_HOURS, type TicketInput, type TicketStore } from '../attachments/tickets.ts'
import { READ_ONLY } from './annotations.ts'
import { formatSize, shellSafeFilename } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// We only need the `attachments` metadata from the Email/get; the detail
// call always resolves text bodies, so cap them to almost nothing.
const METADATA_BODY_VALUE_BYTES = 16

const downloadAttachmentShape = {
  blobId: z
    .string()
    .min(1)
    .describe('The attachment blobId, as listed by search_emails, get_thread, or get_email for that message.'),
  emailId: z.string().min(1).describe('The id of the message the attachment belongs to.'),
}

export const downloadAttachmentInput = z.object(downloadAttachmentShape)

export type DownloadAttachmentArgs = z.infer<typeof downloadAttachmentInput>

export interface DownloadAttachmentDeps {
  emailGetDetail: (p: EmailGetDetailParams) => Promise<EmailDetailRecord[]>
  mintTicket: (input: TicketInput) => string
  // Base URL minted links live under, e.g. https://mcp.langmail.me.
  publicUrl: string
  resolveAccountId: (authorization: string) => Promise<string>
}

export interface DownloadAttachmentContext {
  args: DownloadAttachmentArgs
  token: string
}

export const downloadAttachment = async (
  deps: DownloadAttachmentDeps,
  ctx: DownloadAttachmentContext
): Promise<ToolResult> => {
  const { token, args } = ctx
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)
  const [email] = await deps.emailGetDetail({
    accountId,
    apiUrl: '',
    authorization,
    ids: [args.emailId],
    maxBodyValueBytes: METADATA_BODY_VALUE_BYTES,
  })
  if (!email) {
    return errorResult(`Email not found: ${args.emailId}`)
  }
  const part = (email.attachments ?? []).find((a) => a.blobId === args.blobId)
  if (!part) {
    return errorResult(`No attachment with blobId ${args.blobId} on message ${args.emailId}.`)
  }

  // Canonical name/type come from the message itself, never client input.
  const name = part.name ?? 'attachment'
  const type = part.type ?? 'application/octet-stream'
  const ticket = deps.mintTicket({ accountId, authorization, blobId: args.blobId, name, type })
  const url = `${deps.publicUrl}/attachments/${ticket}`

  return textResult(
    `${name} (${type}, ${formatSize(part.size ?? 0)})\n` +
      `Download URL (expires in ${TICKET_TTL_HOURS} hours):\n` +
      `${url}\n\n` +
      'Save it straight to a file, e.g.:\n' +
      `  curl -sS -o '${shellSafeFilename(name, 'attachment')}' '${url}'\n` +
      'Do not fetch this URL into the conversation — the file may be large.'
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive, tickets: TicketStore, publicUrl: string): DownloadAttachmentDeps => ({
  emailGetDetail: async (p) => emailGetDetail({ ...p, apiUrl: (await live.getSession(p.authorization)).apiUrl }),
  mintTicket: tickets.mint,
  publicUrl,
  resolveAccountId: live.resolveAccountId,
})

// --- MCP registration ----------------------------------------------------

export const registerDownloadAttachment = (
  server: McpServer,
  deps: DownloadAttachmentDeps,
  getToken: () => string
): void => {
  server.registerTool(
    'download_attachment',
    {
      annotations: READ_ONLY,
      description:
        'Get a short-lived download URL for one email attachment, identified ' +
        'by the emailId + blobId that search_emails, get_thread, or get_email lists. The result is metadata ' +
        'plus an HTTPS URL — never the file content. Save the file to disk ' +
        "out-of-band, e.g. `curl -sS -o '<filename>' '<url>'`; do not fetch " +
        'the URL into the conversation, the file may be large. The URL ' +
        `expires after ${TICKET_TTL_HOURS} hours — re-call this tool for a fresh one. ` +
        'For the whole message as an .eml file use download_email instead.',
      inputSchema: z.object(downloadAttachmentShape),
      title: 'Download attachment',
    },
    (args) => {
      const parsed = downloadAttachmentInput.parse(args)
      return downloadAttachment(deps, { args: parsed, token: getToken() })
    }
  )
}
