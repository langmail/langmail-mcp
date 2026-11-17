// Domain types of the collection pipeline. Cards store only content-free
// interaction tuples (date, channel, direction, record id) — never subjects
// or event titles: cards sync to every CardDAV device the user connects,
// where any app holding the contacts permission can read them, and
// mail-derived content must not travel that path. Human-readable interaction
// lines are hydrated from the record ids at query time by search_contacts.

// How reliable the name-to-address pairing is. `confirmed`: the user
// authored mail to the address or scheduled/accepted an event with it.
// `strong`: direct from/to or attendee sighting without a reply. `weak`:
// CC or large-event attendee.
export type Confidence = "confirmed" | "strong" | "weak";

// How much actual interaction exists — computed at read time from the
// stored counters (see scoring.ts), never persisted.
export type Relationship = "active" | "incidental" | "occasional";

export type Channel = "calendar" | "email";

export type Direction = "incoming" | "outgoing";

export type AddressContext = "private" | "work";

// Where a card came from. `derived`: built by the collection fold from mail
// headers and calendar attendees. `authored`: written through the MCP
// contact tools. `imported`: came in from outside Langmail — a CardDAV
// client, a vCard import. An imported card can still carry collected
// history, once collection updated it or merged a Collected card into it.
// The marker matters because `confidence` means different things across them:
// confidence in a derived address is an inference, confidence in an authored
// one is the user's assertion.
export type ContactSource = "authored" | "derived" | "imported";

export type PostalLabel = "home" | "other" | "work";

export type PhoneLabel = "fax" | "home" | "mobile" | "other" | "work";

// The authored half of a contact, flat — the mapping to and from the
// JSContact card shape lives in profile.ts.
export interface PostalAddress {
	city?: string;
	// ISO 3166-1 alpha-2, e.g. `DE`.
	country?: string;
	label: PostalLabel;
	postalCode?: string;
	region?: string;
	// Street including the house number — one line, because the split between
	// the two is itself country-specific.
	street?: string;
}

export interface PhoneNumber {
	label: PhoneLabel;
	number: string;
}

// A birthday as the card stores it: month and day always, the year only
// when it is actually known. Never a `Date` — a placeholder year would turn
// "unknown" into a wrong age on every device the card syncs to.
export interface Birthday {
	day: number;
	month: number;
	year?: number;
}

// A card entry plus the key it is stored under. The key is the handle
// search_contacts prints and update_contact takes, the same way the
// interaction log exposes record ids for chaining. `display` is the card's
// own one-line rendering, which stays correct for an address carrying
// components this flat model has no field for.
export type StoredPostalAddress = PostalAddress & {
	display: string;
	key: string;
};

export type StoredPhoneNumber = PhoneNumber & { key: string };

// One sighting in a card's bounded interaction log. `recordId` is the JMAP
// Email id for `email`, the iCalendar event UID for `calendar` — the handles
// search_contacts hydrates subjects/titles from, and offers for chaining.
export interface InteractionTuple {
	channel: Channel;
	date: string;
	direction: Direction;
	recordId: string;
}

// Per-address collection state inside the extension property.
export interface CollectedAddress {
	confidence: Confidence;
	count: number;
	firstSeen: string;
	lastSeen: string;
}

// The langmail.me:collected payload: machine-owned, updated freely.
// `addresses` is keyed by the lowercased address; `interactions` is
// newest-first, capped at INTERACTION_LOG_SIZE; `relays` lists relay
// addresses observed alongside this person (the LinkedIn digest case),
// so output can surface them as excluded rather than silently dropped.
// `source` records where the card itself came from (see profile.ts) and
// survives every fold, so a later derivation can never relabel a card the
// user authored. `absorbed` lists the ids of Collected cards whose history
// was merged into this card, so a merge whose destroy never landed is not
// summed a second time.
export interface CollectedExtension {
	absorbed?: string[];
	addresses: Record<string, CollectedAddress>;
	interactions: InteractionTuple[];
	relays?: string[];
	source?: ContactSource;
}

// One sighting of one address in one record, graded at collection time.
// The fold consumes these; extraction (observations.ts) produces them.
export interface Observation {
	address: string;
	channel: Channel;
	confidence: Confidence;
	date: string;
	direction: Direction;
	name?: string;
	recordId: string;
}

// A relay address seen in a record — never becomes a card, but is recorded
// on co-occurring people so the output can name it as excluded.
export interface RelaySighting {
	address: string;
	recordId: string;
}

export interface ExtractedObservations {
	observations: Observation[];
	relays: RelaySighting[];
}
