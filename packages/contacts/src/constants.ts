// Every tunable threshold of the collection pipeline in one place, so
// re-grading the address book is a constant change, never a re-collection
// (relationship tiers are computed at read time from stored counters).

// Name of the machine-maintained address book, provisioned lazily on first
// write. Visible in CardDAV clients — benign, since cards carry no mail
// content (see the extension-property comment in types.ts).
export const COLLECTED_BOOK_NAME = 'Collected'

// Vendor extension property (RFC 9553 §1.3: prefixed with a domain the
// vendor controls) carrying the collection data. Stalwart rejects vendor
// properties at the Card's top level but round-trips them inside entry
// objects, so the payload lives inside a dedicated, machine-owned note
// entry: `notes[COLLECTED_NOTE_KEY][COLLECTED_PROPERTY]`. Collection
// updates that entry freely (via the scoped COLLECTED_PATCH_PATH, never
// touching user-authored notes), while standard properties only ever have
// blanks filled.
export const COLLECTED_PROPERTY = 'langmail.me:collected' as const

export const COLLECTED_NOTE_KEY = 'langmail-collected'

// The visible note text CardDAV clients render for the entry — a short
// explanation instead of raw data (the payload itself is invisible to
// standard clients).
export const COLLECTED_NOTE_TEXT = 'Maintained by Langmail contact collection.'

// RFC 8620 §5.3 PatchObject path updating only our note entry.
export const COLLECTED_PATCH_PATH = `notes/${COLLECTED_NOTE_KEY}` as const

// `active` needs at least this many interactions …
export const ACTIVE_MIN_INTERACTIONS = 3
// … one of which within this many days.
export const ACTIVE_RECENT_DAYS = 60

// Above this many attendees, an event stops being evidence of a personal
// relationship: attendee sightings grade `weak` (the workshop case).
export const LARGE_EVENT_ATTENDEES = 8

// The interaction log keeps the last N sightings as content-free tuples …
export const INTERACTION_LOG_SIZE = 5
// … of which concise output shows the most recent M.
export const SHOWN_INTERACTIONS = 3

// Relay addresses remembered per person (for the excluded_relays output).
export const RELAY_LIST_SIZE = 5
