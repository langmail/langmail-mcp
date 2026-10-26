// upload_attachment tool — mint short-lived, single-use URLs the agent PUTs
// local files to. The mirror of download_attachment: the bytes go the agent's
// disk → MCP server → Stalwart's blob store via PUT /attachments/uploads/:token,
// never through the model context, and each PUT answers with the blobId
// create_draft / update_draft already accept.
//
// One step, no confirm call: the blobId only exists once Stalwart has the
// bytes (it is content-derived), so the upload response carries it rather
// than this tool, and nothing has to resolve a staged reference later.
//
// Batched, because "attach these three scans" is the normal request: one call
// mints a URL per file, up to the number of attachments a draft can carry.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization, type JmapLive } from '@langmail/jmap'

import { UNREFERENCED_BLOB_TTL_MINUTES } from '../attachments/upload.ts'
import {
  UPLOAD_TICKET_TTL_MINUTES,
  type UploadTicketInput,
  type UploadTicketStore,
} from '../attachments/upload-tickets.ts'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, mimeTypeFor } from '../drafts/attachments.ts'
import { ACCOUNT_WRITE } from './annotations.ts'
import { formatSize } from './format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const MAX_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024)

const MEDIA_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/u

const fileSchema = z.object({
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
})

const uploadAttachmentShape = {
  files: z
    .array(fileSchema)
    .min(1)
    .max(MAX_ATTACHMENTS)
    .describe(`The local files to upload, at most ${MAX_ATTACHMENTS} per call. Each gets its own URL.`),
}

export const uploadAttachmentInput = z.object(uploadAttachmentShape)

export type UploadAttachmentArgs = z.infer<typeof uploadAttachmentInput>

export interface UploadAttachmentDeps {
  mintUploadTicket: (input: UploadTicketInput) => { expiresAt: number; token: string }
  // Base URL minted links live under, e.g. https://mcp.langmail.me.
  publicUrl: string
  resolveAccountId: (authorization: string) => Promise<string>
}

export interface UploadAttachmentContext {
  args: UploadAttachmentArgs
  token: string
}

export const uploadAttachment = async (
  deps: UploadAttachmentDeps,
  ctx: UploadAttachmentContext
): Promise<ToolResult> => {
  const { args, token } = ctx
  // All or nothing, so the agent never holds URLs for half of what it asked for.
  const oversized = args.files.filter((f) => f.sizeBytes !== undefined && f.sizeBytes > MAX_ATTACHMENT_BYTES)
  if (oversized.length > 0) {
    const named = oversized.map((f) => `${f.filename} (${formatSize(f.sizeBytes ?? 0)})`).join(', ')
    return errorResult(
      `Over the ${MAX_MB} MB an attachment can be: ${named}. No upload URL was issued. Send smaller files, ` +
        'split them, or link to the large one instead.'
    )
  }
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)

  const blocks = args.files.map((file) => {
    const type = mimeTypeFor({ filename: file.filename, ...(file.mimeType ? { mimeType: file.mimeType } : {}) })
    const minted = deps.mintUploadTicket({ accountId, authorization, filename: file.filename, type })
    const url = `${deps.publicUrl}/attachments/uploads/${minted.token}`
    return (
      `${file.filename} (${type}), expires ${new Date(minted.expiresAt).toISOString()}:\n` +
      `  curl -sS -T '<path to ${file.filename.replaceAll("'", '')}>' '${url}'`
    )
  })

  return textResult(
    `Upload URL(s), one per file, each single use, up to ${MAX_MB} MB, valid ${UPLOAD_TICKET_TTL_MINUTES} minutes:\n\n` +
      `${blocks.join('\n\n')}\n\n` +
      'PUT each file straight from disk with its command. Each response is JSON with that file’s `blobId`. ' +
      'Then pass `{"blobId": "<blobId>", "filename": "<filename>"}` for each in the `attachments` of ' +
      `create_draft or update_draft within ${UNREFERENCED_BLOB_TTL_MINUTES} minutes of uploading.\n` +
      'The URLs are credentials: do not show them to the user or paste them anywhere else.'
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
  live: JmapLive,
  uploadTickets: UploadTicketStore,
  publicUrl: string
): UploadAttachmentDeps => ({
  mintUploadTicket: uploadTickets.mint,
  publicUrl,
  resolveAccountId: live.resolveAccountId,
})

// --- MCP registration ----------------------------------------------------

export const registerUploadAttachment = (
  server: McpServer,
  deps: UploadAttachmentDeps,
  getToken: () => string
): void => {
  server.registerTool(
    'upload_attachment',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Get short-lived upload URLs for files on your own disk that should go out as email attachments, ' +
        'so their bytes never pass through the conversation. Use it for any local file — a PDF, a scan, a ' +
        'spreadsheet — instead of reading it as base64 into create_draft’s `content`; use `blobId` ' +
        'straight away instead when the file is already in the mailbox. The result is one URL and curl ' +
        "command per file: PUT the file to it (`curl -sS -T '<file>' '<url>'`), and the response is JSON " +
        'with a `blobId`. Pass that `blobId` with the `filename` in the `attachments` of create_draft or ' +
        `update_draft within ${UNREFERENCED_BLOB_TTL_MINUTES} minutes. Up to ${MAX_ATTACHMENTS} files per ` +
        `call; each URL takes one file of at most ${MAX_MB} MB and expires after ` +
        `${UPLOAD_TICKET_TTL_MINUTES} minutes. The URLs are credentials: never echo them to the user.`,
      inputSchema: uploadAttachmentShape,
      title: 'Upload attachment',
    },
    (args) => {
      const parsed = uploadAttachmentInput.parse(args)
      return uploadAttachment(deps, { args: parsed, token: getToken() })
    }
  )
}
