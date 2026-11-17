// JMAP client label convention (originated in Bulwark). Agent/label keywords
// are namespaced under `$label:` so JMAP clients render them as label chips; a
// bare keyword like `receipt` is invisible there. The prefix is persisted on
// every message, so changing it is a data migration. Defined here exactly once
// so search filters and keyword writes share one prefix. Agent keywords use
// the lowercased label verbatim as the suffix — no slug/sanitize pass.
export const LABEL_KEYWORD_PREFIX = "$label:";

// Build the JMAP keyword string for a label suffix, e.g. `receipt` ->
// `$label:receipt`. The suffix is used verbatim (no lowercasing or slug pass);
// callers are responsible for passing an already-lowercased, slug-stable value.
export const toLabelKeyword = (suffix: string): string =>
	`${LABEL_KEYWORD_PREFIX}${suffix}`;

// The classified email type's own namespace, kept apart from `$label:` because
// the two vocabularies collide: one agent label covers several types
// (`$label:receipt` is written for both `receipt` and `order`), and which
// labels exist at all depends on the user's enabled agent cards. A message
// carries exactly one `$type:` keyword — always the classified type — so a
// search filter on it means precisely what its gloss promises.
export const TYPE_KEYWORD_PREFIX = "$type:";

// Build the JMAP keyword string for an email type, e.g. `ticket` ->
// `$type:ticket`. Like `toLabelKeyword`, the suffix is used verbatim; the
// taxonomy keys are already lowercase slugs.
export const toTypeKeyword = (emailType: string): string =>
	`${TYPE_KEYWORD_PREFIX}${emailType}`;
