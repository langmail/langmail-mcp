// Shared formatters for the lightweight email shape returned by search_emails
// and get_thread. Kept token-frugal: one hit is a few short lines.

import { type EmailAddress, type EmailRecord } from '../jmap/types.ts'

const LABEL_PREFIX = '$label:'

export const formatAddressList = (addrs?: EmailAddress[] | null): string =>
  (addrs ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')

// A message's user-facing "tags" are its `$label:` keywords; system flags
// ($seen, $draft, …) are not tags, so they're filtered out and the prefix is
// stripped for display.
export const emailTags = (e: EmailRecord): string[] =>
  Object.keys(e.keywords ?? {})
    .filter((k) => k.startsWith(LABEL_PREFIX))
    .map((k) => k.slice(LABEL_PREFIX.length))

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
  return lines.join('\n')
}
