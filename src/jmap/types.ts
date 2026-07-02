// Minimal subset of JMAP types used by the MCP service.
//
// JMAP is huge; this file declares only the properties we actually read
// or send. Adding fields when a new tool needs them is preferable to
// trying to mirror the whole RFC up front.

export interface JmapSession {
  apiUrl: string
  primaryAccounts: Record<string, string>
}

export interface JmapRequest {
  methodCalls: [string, Record<string, unknown>, string][]
  using: string[]
}

export interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][]
}

export interface EmailAddress {
  email: string
  name?: string | null
}

// Lightweight shape returned by search_emails and get_thread listings.
// `keywords` is surfaced so callers can show a message's labels (why it
// matched); `threadId` lets a hit be expanded into its whole thread.
export interface EmailRecord {
  from?: EmailAddress[] | null
  id: string
  keywords?: Record<string, boolean> | null
  mailboxIds?: Record<string, boolean> | null
  preview?: string | null
  receivedAt?: string | null
  subject?: string | null
  threadId?: string | null
}

// A single body part reference (JMAP EmailBodyPart, narrowed).
export interface EmailBodyPart {
  partId?: string | null
  type?: string | null
}

// A fetched body value (JMAP EmailBodyValue, narrowed).
export interface EmailBodyValue {
  isEncodingProblem?: boolean
  isTruncated?: boolean
  value: string
}

// Richer shape returned by get_email: recipients plus the text body.
export interface EmailDetailRecord extends EmailRecord {
  bodyValues?: Record<string, EmailBodyValue> | null
  cc?: EmailAddress[] | null
  textBody?: EmailBodyPart[] | null
  to?: EmailAddress[] | null
}

export interface ThreadRecord {
  emailIds: string[]
  id: string
}

export interface MailboxRecord {
  id: string
  name: string
}
