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
  // RFC 8620 §6.1 URI template ({accountId}) for uploading blob bytes —
  // Sieve script content is uploaded through this before SieveScript/set.
  uploadUrl: string
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
  // RFC 8621 §4.1.4 computed property: body parts outside the rendered
  // text/html body. Lightweight list fetches use this for attachment summaries.
  attachments?: EmailBodyPart[] | null
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
  // RFC 8621 §4.1.4 `location` — the part's Content-Location header. The other
  // way an HTML body can point at an inline resource, besides `cid:`.
  location?: string | null
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

// What a staged draft has to round-trip: the detail shape plus the recipient
// and threading properties only composition cares about. `bcc` never appears
// on a received message, and `inReplyTo`/`references` are the RFC 5322
// threading headers in RFC 8621's "asMessageIds" form (bare ids, no angle
// brackets) — reading them back is what lets update_draft rebuild a reply
// without re-deriving the thread.
export interface EmailComposeRecord extends EmailDetailRecord {
  bcc?: EmailAddress[] | null
  htmlBody?: EmailBodyPart[] | null
  inReplyTo?: string[] | null
  references?: string[] | null
  replyTo?: EmailAddress[] | null
}

// RFC 8621 §6 Identity — one address the account is allowed to send as.
// `id` is what EmailSubmission/set requires; `email` is how a caller-supplied
// `from` is matched against the account's aliases.
export interface IdentityRecord {
  email: string
  id: string
  name?: string | null
  replyTo?: EmailAddress[] | null
}

// RFC 8621 §7 EmailSubmission, narrowed to what a send reports back.
// `undoStatus` is `pending` while the submission can still be canceled,
// `final` once it can't; `sendAt` is when the server released (or will
// release) the message.
export interface EmailSubmissionRecord {
  id: string
  sendAt?: string | null
  undoStatus?: string | null
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

// RFC 9610 AddressBook, narrowed. `name` is how the collected book is
// located ("Collected"); `isDefault` marks the book ContactCard creates
// land in when no book is named.
export interface AddressBookRecord {
  id: string
  isDefault?: boolean | null
  name: string
}

// JSContact EmailAddress (RFC 9553 §2.3.1). `contexts` carries the
// work/private classification search_contacts biases on.
export interface ContactCardEmail {
  address: string
  contexts?: Record<string, boolean> | null
  [extension: `${string}:${string}`]: unknown
}

export interface ContactCardName {
  full?: string | null
}

// RFC 9553 Note object, narrowed. Stalwart rejects vendor extension
// properties at the Card's top level but round-trips them inside entry
// objects — so the collected-contacts payload rides in a dedicated note
// entry (see @langmail/contacts), typed here as the extension passthrough.
export interface ContactCardNote {
  note: string
  [extension: `${string}:${string}`]: unknown
}

export interface ContactCardOrganization {
  name?: string | null
}

// A ContactCard draft: JSContact Card (RFC 9553) narrowed to what Langmail
// writes, before the server assigns an id.
export interface ContactCardDraft {
  addressBookIds: Record<string, boolean>
  emails?: Record<string, ContactCardEmail> | null
  name?: ContactCardName | null
  notes?: Record<string, ContactCardNote> | null
  organizations?: Record<string, ContactCardOrganization> | null
  uid?: string | null
  version?: string | null
}

export interface ContactCard extends ContactCardDraft {
  id: string
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
