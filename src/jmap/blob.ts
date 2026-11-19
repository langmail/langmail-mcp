// Blob download via the session's RFC 8620 §6.2 `downloadUrl` URI template.
//
// The template carries `{accountId}`, `{blobId}`, `{name}`, and `{type}`
// placeholders (Stalwart: `/jmap/download/{accountId}/{blobId}/{name}?accept={type}`).
// Expansion URI-encodes every value so filenames with spaces, slashes, or
// unicode and media types with `/` stay one path/query segment.

import { JmapError } from './session.ts'
import { fetchWithHeadersDeadline, jmapTimeoutSignal } from './timeout.ts'

export interface BlobDownloadParams {
  accountId: string
  // Full Authorization header value — same seam as every other wrapper.
  authorization: string
  blobId: string
  // The session's `downloadUrl` URI template.
  downloadUrl: string
  name: string
  type: string
}

export const blobDownloadUrl = (
  template: string,
  p: Omit<BlobDownloadParams, 'authorization' | 'downloadUrl'>
): string =>
  template
    .replaceAll('{accountId}', encodeURIComponent(p.accountId))
    .replaceAll('{blobId}', encodeURIComponent(p.blobId))
    .replaceAll('{name}', encodeURIComponent(p.name))
    .replaceAll('{type}', encodeURIComponent(p.type))

// Fetch the blob and hand back the *streamed* Response — the body is never
// buffered here, so a large attachment can be piped straight through to the
// consumer (the MCP `/attachments/:token` route) without memory pressure.
export const blobDownload = async (p: BlobDownloadParams): Promise<Response> => {
  const url = blobDownloadUrl(p.downloadUrl, p)
  // Headers-only deadline: the body is piped straight through to the consumer,
  // so a whole-exchange timeout would cut a slow attachment off mid-transfer.
  const res = await fetchWithHeadersDeadline(url, { headers: { authorization: p.authorization } })
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap blob download returned ${res.status}`)
  }
  return res
}

// Blob upload via the session's RFC 8620 §6.1 `uploadUrl` URI template
// (single `{accountId}` placeholder). Returns the server-assigned blobId,
// the handle a subsequent set call (e.g. SieveScript/set) references.

export interface BlobUploadParams {
  accountId: string
  // Full Authorization header value — same seam as every other wrapper.
  authorization: string
  content: string | Uint8Array
  // Media type of the uploaded bytes (e.g. "application/sieve").
  type: string
  // The session's `uploadUrl` URI template.
  uploadUrl: string
}

export const blobUpload = async (p: BlobUploadParams): Promise<string> => {
  const url = p.uploadUrl.replaceAll('{accountId}', encodeURIComponent(p.accountId))
  const res = await fetch(url, {
    body: p.content,
    headers: { authorization: p.authorization, 'content-type': p.type },
    method: 'POST',
    signal: jmapTimeoutSignal(),
  })
  // RFC 8620 leaves the success code to the server; Stalwart answers 200.
  if (res.status !== 200 && res.status !== 201) {
    throw new JmapError(res.status, `jmap blob upload returned ${res.status}`)
  }
  const body = (await res.json()) as { blobId?: unknown }
  if (typeof body.blobId !== 'string') {
    throw new JmapError(res.status, 'malformed jmap blob upload response')
  }
  return body.blobId
}
