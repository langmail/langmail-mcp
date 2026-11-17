// Minimal subset of JMAP types shared by the tools and helpers in src/.
//
// JMAP is huge; this file declares only the properties we actually read
// or send. Adding fields when a new tool needs them is preferable to
// trying to mirror the whole RFC up front.

export interface JmapSession {
	apiUrl: string;
	// RFC 8620 §6.2 URI template ({accountId}/{blobId}/{name}/{type}) for
	// fetching raw blob bytes — attachments are downloaded through this.
	downloadUrl: string;
	primaryAccounts: Record<string, string>;
	// RFC 8620 §6.1 URI template ({accountId}) for uploading blob bytes —
	// Sieve script content is uploaded through this before SieveScript/set.
	uploadUrl: string;
	// RFC 8620 §2: the name the credential signed in as. On Stalwart this is
	// the account's primary address, so it is the principal mail is sent from.
	// Absent for an anonymous session.
	username?: string;
}

export interface JmapRequest {
	methodCalls: [string, Record<string, unknown>, string][];
	using: string[];
}

export interface JmapResponse {
	methodResponses: [string, Record<string, unknown>, string][];
}

export interface EmailAddress {
	email: string;
	name?: string | null;
}

// Lightweight shape returned by search_emails and get_thread listings.
// `keywords` is surfaced so callers can show a message's labels (why it
// matched); `threadId` lets a hit be expanded into its whole thread.
export interface EmailRecord {
	// RFC 8621 §4.1.4 computed property: body parts outside the rendered
	// text/html body. Lightweight list fetches use this for attachment summaries.
	attachments?: EmailBodyPart[] | null;
	from?: EmailAddress[] | null;
	hasAttachment?: boolean | null;
	id: string;
	keywords?: Record<string, boolean> | null;
	mailboxIds?: Record<string, boolean> | null;
	preview?: string | null;
	receivedAt?: string | null;
	subject?: string | null;
	threadId?: string | null;
}

// A single body part reference (JMAP EmailBodyPart, narrowed). The blob
// fields (blobId/name/size/disposition/cid) are populated for attachment
// parts; `blobId` is the retrieval handle for blob download.
export interface EmailBodyPart {
	blobId?: string | null;
	cid?: string | null;
	disposition?: string | null;
	// RFC 8621 §4.1.4 `location` — the part's Content-Location header. The other
	// way an HTML body can point at an inline resource, besides `cid:`.
	location?: string | null;
	name?: string | null;
	partId?: string | null;
	size?: number | null;
	type?: string | null;
}

// A fetched body value (JMAP EmailBodyValue, narrowed).
export interface EmailBodyValue {
	isEncodingProblem?: boolean;
	isTruncated?: boolean;
	value: string;
}

// Richer shape returned by get_email: recipients plus the text body.
// `messageId` is the parsed RFC 5322 Message-ID header (a list per RFC 8621).
export interface EmailDetailRecord extends EmailRecord {
	// RFC 8621 §4.1.1 metadata: the blob holding the raw RFC 5322 message —
	// get_email downloads this to run the langmail cleaning pipeline.
	blobId?: string | null;
	bodyValues?: Record<string, EmailBodyValue> | null;
	cc?: EmailAddress[] | null;
	// Part metadata for the rendered HTML body (values are not fetched with the
	// detail call; the blobId is the handle for a full, untruncated download).
	htmlBody?: EmailBodyPart[] | null;
	messageId?: string[] | null;
	// Raw message size in octets (attachments included).
	size?: number | null;
	textBody?: EmailBodyPart[] | null;
	to?: EmailAddress[] | null;
}

// What unsubscribe_from_list reads off one message: the RFC 2369 / RFC 8058
// headers, where it sits (Junk), how it was classified (keywords), whom this
// copy was delivered to, and the text body for the footer-link fallback.
// `header:List-Unsubscribe` is RFC 8621's Raw form — the value exactly as
// written, folding included — so the caller does its own unfolding.
export interface EmailUnsubscribeRecord extends EmailDetailRecord {
	"header:Delivered-To:asText:all"?: string[] | null;
	"header:List-Unsubscribe"?: string | null;
	"header:List-Unsubscribe-Post:asText"?: string | null;
}

// What a staged draft has to round-trip: the detail shape plus the recipient
// and threading properties only composition cares about. `bcc` never appears
// on a received message, and `inReplyTo`/`references` are the RFC 5322
// threading headers in RFC 8621's "asMessageIds" form (bare ids, no angle
// brackets) — reading them back is what lets update_draft rebuild a reply
// without re-deriving the thread.
export interface EmailComposeRecord extends EmailDetailRecord {
	bcc?: EmailAddress[] | null;
	inReplyTo?: string[] | null;
	references?: string[] | null;
	replyTo?: EmailAddress[] | null;
	// RFC 8621 `sentAt`: the Date header, as the sender stamped it.
	sentAt?: string | null;
}

// RFC 8621 §6 Identity — one address the account is allowed to send as.
// `id` is what EmailSubmission/set requires; `email` is how a caller-supplied
// `from` is matched against the account's aliases.
export interface IdentityRecord {
	email: string;
	id: string;
	name?: string | null;
	replyTo?: EmailAddress[] | null;
}

// RFC 8621 §7 EmailSubmission, narrowed to what a send reports back.
// `undoStatus` is `pending` while the submission can still be canceled,
// `final` once it can't; `sendAt` is when the server released (or will
// release) the message.
export interface EmailSubmissionRecord {
	id: string;
	sendAt?: string | null;
	undoStatus?: string | null;
}

export interface ThreadRecord {
	emailIds: string[];
	id: string;
}

// `role` is the RFC 8621 special-use role (`inbox`, `archive`, `sent`, …);
// null/absent for user-created mailboxes. It's the stable way to locate the
// inbox, independent of the localized display name.
export interface MailboxRecord {
	id: string;
	name: string;
	role?: string | null;
}

// RFC 9610 AddressBook, narrowed. `name` is how the collected book is
// located ("Collected"); `isDefault` marks the book ContactCard creates
// land in when no book is named.
export interface AddressBookRecord {
	id: string;
	isDefault?: boolean | null;
	name: string;
}

// JSContact EmailAddress (RFC 9553 §2.3.1). `contexts` carries the
// work/private classification search_contacts biases on. `pref` (RFC 9553
// §1.5.4, 1–100, lower is more preferred) marks the address mail should go
// to; CardDAV carries it as vCard `PREF`/`TYPE=pref`.
export interface ContactCardEmail {
	address: string;
	contexts?: Record<string, boolean> | null;
	pref?: number | null;
	[extension: `${string}:${string}`]: unknown;
}

export interface ContactCardName {
	full?: string | null;
}

// RFC 9553 Note object, narrowed. Stalwart rejects vendor extension
// properties at the Card's top level but round-trips them inside entry
// objects — so the collected-contacts payload rides in a dedicated note
// entry (see `src/contacts`), typed here as the extension passthrough.
export interface ContactCardNote {
	note: string;
	[extension: `${string}:${string}`]: unknown;
}

export interface ContactCardOrganization {
	name?: string | null;
}

// JSContact Phone (RFC 9553 §2.3.3). `features` carries what the number is
// good for (`mobile`, `fax`, `voice`, …), `contexts` where it is used
// (`work`, `private`) — the two axes vCard collapsed into one TYPE list.
export interface ContactCardPhone {
	contexts?: Record<string, boolean> | null;
	features?: Record<string, boolean> | null;
	number: string;
	[extension: `${string}:${string}`]: unknown;
}

// One part of a structured postal address (RFC 9553 §2.5.1). `kind` is from
// the registry — `name` is the street name, `number` the house number,
// `locality` the city, `region` the state/province, `postcode` the ZIP.
export interface ContactCardAddressComponent {
	kind: string;
	value: string;
}

// JSContact Address (RFC 9553 §2.5.1). Structured by design: address
// formats are country-specific, and an agent addressing a letter needs the
// parts separately. `countryCode` is ISO 3166-1 alpha-2; `contexts` uses
// `private`/`work` (there is no `home` in JSContact).
export interface ContactCardAddress {
	components?: ContactCardAddressComponent[] | null;
	contexts?: Record<string, boolean> | null;
	countryCode?: string | null;
	full?: string | null;
	[extension: `${string}:${string}`]: unknown;
}

// JSContact PartialDate (RFC 9553 §2.8.1). Every part is optional by
// design: a birthday without a year is the common case, and a placeholder
// year would be a bug — so no `Date` object anywhere near this.
// `calendarScale` is a CLDR calendar name (`chinese`, `hebrew`, …); absent
// means `gregorian`, the only scale Langmail interprets.
export interface ContactCardPartialDate {
	calendarScale?: string | null;
	day?: number;
	month?: number;
	year?: number;
}

// JSContact Anniversary (RFC 9553 §2.8.1). `kind` is `birth`, `wedding`,
// `death` or a vendor value; CardDAV round-trips the first three as `BDAY`,
// `ANNIVERSARY` and `DEATHDATE` (RFC 9555). Langmail reads and writes only
// `birth` and preserves every other entry untouched.
//
// `date` is narrowed to the PartialDate form. The RFC also allows a
// Timestamp (`{ "@type": "Timestamp", utc }`, what a vCard `BDAY` with a
// time component becomes); such an entry has no `month`/`day` and reads as
// no birthday, and a write replaces it with a PartialDate.
export interface ContactCardAnniversary {
	date: ContactCardPartialDate;
	kind: string;
	[extension: `${string}:${string}`]: unknown;
}

// JSContact Title (RFC 9553 §2.2.5). `kind` is `title` (a job title, the
// default) or `role` (what the person is: "lawyer", "landlord"); CardDAV
// round-trips them as vCard `TITLE` and `ROLE`.
export interface ContactCardTitle {
	kind?: string | null;
	name: string;
	organizationId?: string | null;
	[extension: `${string}:${string}`]: unknown;
}

// A ContactCard draft: JSContact Card (RFC 9553) narrowed to what Langmail
// writes, before the server assigns an id.
export interface ContactCardDraft {
	addressBookIds: Record<string, boolean>;
	addresses?: Record<string, ContactCardAddress> | null;
	anniversaries?: Record<string, ContactCardAnniversary> | null;
	emails?: Record<string, ContactCardEmail> | null;
	name?: ContactCardName | null;
	notes?: Record<string, ContactCardNote> | null;
	organizations?: Record<string, ContactCardOrganization> | null;
	phones?: Record<string, ContactCardPhone> | null;
	titles?: Record<string, ContactCardTitle> | null;
	uid?: string | null;
	version?: string | null;
}

export interface ContactCard extends ContactCardDraft {
	id: string;
}

// The delta returned by Email/changes between two states (RFC 8621 §5.2).
// `newState` becomes the next poll's cursor; `hasMoreChanges` signals the
// caller to page again from `newState` before treating the batch as drained.
export interface EmailChangesResult {
	created: string[];
	destroyed: string[];
	hasMoreChanges: boolean;
	newState: string;
	oldState: string;
	updated: string[];
}
