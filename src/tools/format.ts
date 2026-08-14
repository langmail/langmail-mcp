// Shared formatters for the lightweight email shape returned by search_emails
// and get_thread. Kept token-frugal: one hit is a few short lines.

import {
  type EmailAddress,
  type EmailBodyPart,
  type EmailRecord,
  LABEL_KEYWORD_PREFIX,
  TYPE_KEYWORD_PREFIX,
} from '@langmail/jmap'

const LIST_ATTACHMENT_LIMIT = 5

// The two keyword namespaces a reader cares about: agent labels and the
// classified email type. Everything else ($seen, $draft, …) is a system flag.
const TAG_PREFIXES = [LABEL_KEYWORD_PREFIX, TYPE_KEYWORD_PREFIX]

export const formatAddressList = (addrs?: EmailAddress[] | null): string =>
  (addrs ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')

// A message's user-facing "tags" are its `$label:` agent labels and its
// `$type:` classified type; system flags ($seen, $draft, …) are not tags, so
// they're filtered out and the prefix is stripped for display. The two
// namespaces overlap by design — an agent writes `$label:receipt` for the same
// mail the classifier types `receipt` — so tags are deduplicated by the
// rendered suffix rather than shown twice.
export const emailTags = (e: EmailRecord): string[] => {
  const tags = new Set<string>()
  for (const keyword of Object.keys(e.keywords ?? {})) {
    const prefix = TAG_PREFIXES.find((p) => keyword.startsWith(p))
    if (prefix) {
      tags.add(keyword.slice(prefix.length))
    }
  }
  return [...tags]
}

// Email/get doesn't guarantee list order; reorder fetched records to match a
// caller-supplied id order (the query's newest-first sort, or a thread's
// chronological order), dropping ids the server didn't return.
export const orderById = (ids: string[], records: EmailRecord[]): EmailRecord[] => {
  const byId = new Map(records.map((e) => [e.id, e]))
  return ids.map((id) => byId.get(id)).filter((e): e is EmailRecord => Boolean(e))
}

export interface EmailLineOptions {
  requested?: boolean
}

const normalizedSnippet = (preview?: string | null): string => (preview ?? '').replace(/\s+/g, ' ').trim()

// A part referenced from the rendered HTML body by Content-ID (logos,
// signature images, tracking pixels). Full get_email output marks these;
// list-level output and preview_email's attachment count hide them so real
// documents stand out.
export const isInlinePart = (part: EmailBodyPart): boolean => part.disposition === 'inline' && Boolean(part.cid)

export const formatAttachmentLine = (idx: number, part: EmailBodyPart): string => {
  const pieces = [
    `${part.name ?? '(unnamed)'} — ${part.type ?? 'application/octet-stream'}, ${formatSize(part.size ?? 0)}`,
  ]
  if (isInlinePart(part)) {
    pieces.push('inline')
  }
  pieces.push(`blobId: ${part.blobId ?? '(none)'}`)
  return `${idx}. ${pieces.join(' — ')}`
}

const formatListAttachmentLines = (e: EmailRecord): string[] => {
  if (!e.hasAttachment) {
    return []
  }
  const parts = (e.attachments ?? []).filter((part) => !isInlinePart(part))
  if (parts.length === 0) {
    return ['   attachments: yes']
  }
  const shown = parts.slice(0, LIST_ATTACHMENT_LIMIT)
  const lines = ['   attachments:', ...shown.map((part, i) => `   ${formatAttachmentLine(i + 1, part)}`)]
  const hiddenCount = parts.length - shown.length
  if (hiddenCount > 0) {
    lines.push(`   … +${hiddenCount} more (see get_email)`)
  }
  return lines
}

export const formatEmailLine = (idx: number, e: EmailRecord, opts: EmailLineOptions = {}): string => {
  const marker = opts.requested ? '  ← requested' : ''
  const lines = [
    `${idx}. ${e.subject ?? '(no subject)'}${marker}`,
    `   id: ${e.id}`,
    `   from: ${formatAddressList(e.from) || '(unknown sender)'}`,
    `   date: ${e.receivedAt ?? ''}`,
  ]
  const tags = emailTags(e)
  if (tags.length > 0) {
    lines.push(`   tags: ${tags.join(', ')}`)
  }
  const snippet = normalizedSnippet(e.preview)
  if (snippet) {
    lines.push(`   snippet: ${snippet}`)
  }
  lines.push(...formatListAttachmentLines(e))
  return lines.join('\n')
}

// Human-readable size for attachment listings, e.g. "182.4 KB".
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
