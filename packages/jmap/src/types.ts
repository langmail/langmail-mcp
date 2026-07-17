// Minimal subset of JMAP types shared across Langmail's TS consumers.
//
// JMAP is huge; this file declares only the properties we actually read
// or send. Adding fields when a new tool needs them is preferable to
// trying to mirror the whole RFC up front.

export interface JmapSession {
  apiUrl: string
  // RFC 8620 §6.2 URI template ({accountId}/{blobId}/{name}/{type}) for
  // fetching raw blob bytes — attachments are downloaded through this.
  downloadUrl: string
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
  hasAttachment?: boolean | null
  id: string
  keywords?: Record<string, boolean> | null
  mailboxIds?: Record<string, boolean> | null
  preview?: string | null
  receivedAt?: string | null
  subject?: string | null
  threadId?: string | null
}

// A single body part reference (JMAP EmailBodyPart, narrowed). The blob
// fields (blobId/name/size/disposition/cid) are populated for attachment
// parts; `blobId` is the retrieval handle for blob download.
export interface EmailBodyPart {
  blobId?: string | null
  cid?: string | null
  disposition?: string | null
  name?: string | null
  partId?: string | null
  size?: number | null
  type?: string | null
}

// A fetched body value (JMAP EmailBodyValue, narrowed).
export interface EmailBodyValue {
  isEncodingProblem?: boolean
  isTruncated?: boolean
  value: string
}

// Richer shape returned by get_email: recipients plus the text body.
// `messageId` is the parsed RFC 5322 Message-ID header (a list per RFC 8621).
export interface EmailDetailRecord extends EmailRecord {
  // RFC 8621 §4.1.4 computed property: body parts outside the rendered
  // text/html body — the message's attachments (including cid-inline ones).
  attachments?: EmailBodyPart[] | null
  // RFC 8621 §4.1.1 metadata: the blob holding the raw RFC 5322 message —
  // get_email downloads this to run the langmail cleaning pipeline.
  blobId?: string | null
  bodyValues?: Record<string, EmailBodyValue> | null
  cc?: EmailAddress[] | null
  messageId?: string[] | null
  // Raw message size in octets (attachments included).
  size?: number | null
  textBody?: EmailBodyPart[] | null
  to?: EmailAddress[] | null
}

export interface ThreadRecord {
  emailIds: string[]
  id: string
}

// `role` is the RFC 8621 special-use role (`inbox`, `archive`, `sent`, …);
// null/absent for user-created mailboxes. It's the stable way to locate the
// inbox for auto-archive, independent of the localized display name.
export interface MailboxRecord {
  id: string
  name: string
  role?: string | null
}

// The delta returned by Email/changes between two states (RFC 8621 §5.2).
// `newState` becomes the next poll's cursor; `hasMoreChanges` signals the
// caller to page again from `newState` before treating the batch as drained.
export interface EmailChangesResult {
  created: string[]
  destroyed: string[]
  hasMoreChanges: boolean
  newState: string
  oldState: string
  updated: string[]
}
