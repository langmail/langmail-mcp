// The searchable keyword vocabulary. Derived from the classification taxonomy
// in `email-types.ts` (not from the agent set) so a value means the same thing
// for every user: agent labels are per-user configurable and coarser than the
// taxonomy — one agent writes `$label:receipt` for both `receipt` and `order`
// mail, and one writes `$label:notification` for `notification`,
// `security_alert`, and `terms`. Exposed to the model as a z.enum on
// search_emails; mapped to JMAP keywords server-side.

import { toLabelKeyword, toTypeKeyword } from '../jmap/index.ts'
import { EMAIL_TYPE_VALUES, EMAIL_TYPES } from './email-types.ts'

// RFC 8621 §4.1.1 system keywords: "has been read" and "flagged for urgent or
// special attention" — the keyword Gmail's STARRED and the mail-rule flag
// action already map to. mark_emails sets them, search_emails filters on and
// shows them.
export const SEEN_KEYWORD = '$seen'
export const FLAGGED_KEYWORD = '$flagged'

// The one value that is not an email type: a flag orthogonal to the taxonomy
// (a message of any type can be a to-do), so it keeps mapping onto the agent
// label the email-agent writes.
const TODO_VALUE = 'todo'

// enum value -> human gloss. Type glosses live next to the taxonomy itself;
// `todo` is agent/user bookkeeping the taxonomy doesn't model, glossed here.
const KEYWORD_GLOSSES: Record<string, string> = {
  ...Object.fromEntries(EMAIL_TYPE_VALUES.map((type) => [type, EMAIL_TYPES[type].search])),
  [TODO_VALUE]: 'Messages the user (or an agent) flagged as an action item / to-do; set or clear it with mark_emails.',
}

// Ordered enum values: the taxonomy in its canonical order, then `todo`. The
// non-empty tuple type is what z.enum() requires.
export const KEYWORD_VALUES = Object.keys(KEYWORD_GLOSSES) as [string, ...string[]]

// A single description string glossing every value — zod enums have no
// per-member describe, so we compose one self-documenting blurb that grows
// automatically as the taxonomy grows. The lead paragraph is the part that
// changes retrieval behaviour: transactional mail is exactly the mail whose
// words never appear in its own subject, so an agent that reaches for
// free-text first will not find it.
export const KEYWORDS_DESCRIPTION = `Filter by classified email type; multiple values are combined with OR, and the filter composes with query/from/after/before/mailbox. Transactional mail (tickets, invoices, orders, bookings, confirmations) rarely names its own type in the subject or body — a cinema booking is titled after the film, an invoice after the vendor — so for requests like "find my tickets" or "show the invoice from X", prefer this filter plus an after/before window over a free-text query. Messages that predate classification carry no type, so fall back to query when a filter returns nothing. Values: ${Object.entries(
  KEYWORD_GLOSSES
)
  .map(([value, gloss]) => `"${value}" = ${gloss}`)
  .join('; ')}`

// Two namespaces behind one enum: email types resolve to the `$type:`
// keywords the email-agent writes for every classified message, while `todo`
// resolves to the `$label:todo` agent label (canonical since the JMAP-first
// migration — the legacy Gmail-echoed `$label:to-do` was dropped with it).
// Enum values are already lowercase slugs and are used verbatim as suffixes.
export const keywordToJmapKeyword = (value: string): string =>
  value === TODO_VALUE ? toLabelKeyword(value) : toTypeKeyword(value)

// The keyword mark_emails sets for `todo: true`; search_emails filters on it
// with keywords: ["todo"] (hosted) or todo: true (self-hosted).
export const TODO_KEYWORD = keywordToJmapKeyword(TODO_VALUE)
