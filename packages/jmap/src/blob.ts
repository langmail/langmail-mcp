// Blob download via the session's RFC 8620 §6.2 `downloadUrl` URI template.
//
// The template carries `{accountId}`, `{blobId}`, `{name}`, and `{type}`
// placeholders (Stalwart: `/jmap/download/{accountId}/{blobId}/{name}?accept={type}`).
// Expansion URI-encodes every value so filenames with spaces, slashes, or
// unicode and media types with `/` stay one path/query segment.

import { JmapError } from './session.ts'

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
  const res = await fetch(url, { headers: { authorization: p.authorization } })
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap blob download returned ${res.status}`)
  }
  return res
}
