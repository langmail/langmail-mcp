// The email-type taxonomy: the exact set of types Langmail's classifier
// assigns, the vocabulary behind the `$type:` JMAP keywords, and the value
// set `search_emails` exposes as a filter. Inlined from Langmail's hosted
// code; keys, glosses and order must stay the same as there.

/**
 * One entry in the taxonomy: the display name Langmail's own surfaces render,
 * and the one-sentence gloss agent-facing tool schemas show when offering the
 * type as a search facet. The gloss is written for a model choosing a filter,
 * so it names what belongs in the type rather than describing it abstractly.
 */
interface EmailType {
	name: string;
	search: string;
}

/**
 * The ten classified types, in the order Langmail's classifier prompt lists
 * them. Keys are used verbatim as `$type:` keyword suffixes and as
 * `search_emails` enum values, so they must stay lowercase, slug-stable, and
 * free of RFC 8621's forbidden keyword characters.
 */
export const EMAIL_TYPES = {
	direct: {
		name: "💬 Direct",
		search:
			"Person-to-person mail written by an individual, with no platform in between.",
	},
	newsletter: {
		name: "📧 Newsletter",
		search: "Recurring updates, news digests, and curated broadcast content.",
	},
	promotional: {
		name: "🎯 Promotional",
		search: "Marketing mail, sales pitches, and discount offers.",
	},
	notification: {
		name: "🔔 Notification",
		search:
			"Platform activity alerts and account notices such as billing or subscription problems.",
	},
	ticket: {
		name: "🎫 Ticket",
		search: "Event tickets: theater, cinema, concerts, conferences.",
	},
	receipt: {
		name: "🧾 Receipt",
		search: "Transaction receipts and payment confirmations.",
	},
	order: {
		name: "📦 Order",
		search:
			"Order confirmations, shipping updates, delivery tracking, returns and refunds.",
	},
	scheduling: {
		name: "📅 Scheduling",
		search:
			"Calendar invites and booking confirmations — hotels, flights, restaurants, meetings, appointments.",
	},
	security_alert: {
		name: "🔐 Security Alert",
		search:
			"Login alerts, password changes, verification codes, and account recovery notices.",
	},
	terms: {
		name: "📜 Terms",
		search:
			"Terms of service and privacy policy updates, and other legal or compliance notices.",
	},
} as const satisfies Record<string, EmailType>;

type EmailTypeUnion = keyof typeof EMAIL_TYPES;

/**
 * The taxonomy keys as a non-empty tuple — what `z.enum` and the MCP search
 * enum both need, and the iteration order for "clear every other type keyword"
 * writes.
 */
export const EMAIL_TYPE_VALUES = Object.keys(EMAIL_TYPES) as [
	EmailTypeUnion,
	...EmailTypeUnion[],
];
