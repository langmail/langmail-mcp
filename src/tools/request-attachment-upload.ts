// request_attachment_upload tool — mint a short-lived, single-use URL the agent
// PUTs a local file to. The mirror of download_attachment: the bytes go the
// agent's disk → MCP server → Stalwart's blob store via
// PUT /attachments/uploads/:token, never through the model context, and the
// PUT answers with the blobId create_draft / update_draft already accept.
//
// One step, no confirm call: the blobId only exists once Stalwart has the
// bytes (it is content-derived), so the upload response carries it rather
// than this tool, and nothing has to resolve a staged reference later.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization, type JmapLive } from '@langmail/jmap'

import { UNREFERENCED_BLOB_TTL_MINUTES } from '../attachments/upload.ts'
import {
  UPLOAD_TICKET_TTL_MINUTES,
  type UploadTicketInput,
  type UploadTicketStore,
} from '../attachments/upload-tickets.ts'
import { MAX_ATTACHMENT_BYTES, mimeTypeFor } from '../drafts/attachments.ts'
import { ACCOUNT_WRITE } from './annotations.ts'
import { formatSize } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const MAX_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024)

const MEDIA_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/u

const requestAttachmentUploadShape = {
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe('Name the recipient will see, e.g. "Bescheid-2025.pdf". Pass the same name to create_draft.'),
  mimeType: z
    .string()
    .max(255)
    // It becomes the blob's Content-Type header, so refuse anything that is
    // not `type/subtype` here, before a URL is spent on it.
    .regex(MEDIA_TYPE_RE, 'Expected a media type such as "application/pdf".')
    .optional()
    .describe('Media type, e.g. "application/pdf". Guessed from the filename extension when omitted.'),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(`The file's size in bytes, if you know it — a file over ${MAX_MB} MB is refused before you upload.`),
}

export const requestAttachmentUploadInput = z.object(requestAttachmentUploadShape)

export type RequestAttachmentUploadArgs = z.infer<typeof requestAttachmentUploadInput>

export interface RequestAttachmentUploadDeps {
  mintUploadTicket: (input: UploadTicketInput) => { expiresAt: number; token: string }
  // Base URL minted links live under, e.g. https://mcp.langmail.me.
  publicUrl: string
  resolveAccountId: (authorization: string) => Promise<string>
}

export interface RequestAttachmentUploadContext {
  args: RequestAttachmentUploadArgs
  token: string
}

export const requestAttachmentUpload = async (
  deps: RequestAttachmentUploadDeps,
  ctx: RequestAttachmentUploadContext
): Promise<ToolResult> => {
  const { args, token } = ctx
  if (args.sizeBytes !== undefined && args.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return errorResult(
      `${args.filename} is ${formatSize(args.sizeBytes)}, over the ${MAX_MB} MB an attachment can be, so no ` +
        'upload URL was issued. Send a smaller file, split it, or link to it instead.'
    )
  }
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)
  const type = mimeTypeFor({ filename: args.filename, ...(args.mimeType ? { mimeType: args.mimeType } : {}) })
  const minted = deps.mintUploadTicket({ accountId, authorization, filename: args.filename, type })
  const url = `${deps.publicUrl}/attachments/uploads/${minted.token}`

  return textResult(
    `Upload URL for ${args.filename} (${type}, up to ${MAX_MB} MB), single use, expires ` +
      `${new Date(minted.expiresAt).toISOString()} (in ${UPLOAD_TICKET_TTL_MINUTES} minutes):\n` +
      `${url}\n\n` +
      'PUT the file straight from disk, e.g.:\n' +
      `  curl -sS -T '<path to the file>' '${url}'\n` +
      'The response is JSON with the `blobId`. Then pass ' +
      `{"blobId": "<blobId>", "filename": ${JSON.stringify(args.filename)}} in the \`attachments\` of ` +
      `create_draft or update_draft within ${UNREFERENCED_BLOB_TTL_MINUTES} minutes of uploading.\n` +
      'The URL is a credential: do not show it to the user or paste it anywhere else.'
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
  live: JmapLive,
  uploadTickets: UploadTicketStore,
  publicUrl: string
): RequestAttachmentUploadDeps => ({
  mintUploadTicket: uploadTickets.mint,
  publicUrl,
  resolveAccountId: live.resolveAccountId,
})

// --- MCP registration ----------------------------------------------------

export const registerRequestAttachmentUpload = (
  server: McpServer,
  deps: RequestAttachmentUploadDeps,
  getToken: () => string
): void => {
  server.registerTool(
    'request_attachment_upload',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Get a short-lived upload URL for a file on your own disk that should go out as an email ' +
        'attachment, so its bytes never pass through the conversation. Use it for any local file — a ' +
        'PDF, a scan, a spreadsheet — instead of reading it as base64 into create_draft’s `content`; ' +
        'use `blobId` straight away instead when the file is already in the mailbox. The result is the URL ' +
        "and a curl command: PUT the file to it (`curl -sS -T '<file>' '<url>'`), and the response is JSON " +
        'with a `blobId`. Pass that `blobId` with the `filename` in the `attachments` of create_draft or ' +
        `update_draft within ${UNREFERENCED_BLOB_TTL_MINUTES} minutes. One URL takes one file of at most ` +
        `${MAX_MB} MB and expires after ${UPLOAD_TICKET_TTL_MINUTES} minutes — call again for each file. ` +
        'The URL is a credential: never echo it to the user.',
      inputSchema: requestAttachmentUploadShape,
      title: 'Request attachment upload',
    },
    (args) => {
      const parsed = requestAttachmentUploadInput.parse(args)
      return requestAttachmentUpload(deps, { args: parsed, token: getToken() })
    }
  )
}
