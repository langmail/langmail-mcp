// The email-type taxonomy as the MCP server offers it: the `$type:` keyword
// suffixes `search_emails` filters on, each with the gloss its schema shows.
// The taxonomy itself lives in `packages/agents/src/email-type.ts`, which the
// classifier works from; this is a copy so the server builds on its own, and
// `packages/agents/src/mcp-email-type-parity.test.ts` fails when the two differ
// (ADR 0010).

/**
 * The ten classified types, in the order the classifier prompt lists them,
 * each with a one-sentence gloss written for a model choosing a filter. Keys
 * are used verbatim as `$type:` keyword suffixes and as `search_emails` enum
 * values.
 */
export const EMAIL_TYPES = {
  direct: {
    search: 'Person-to-person mail written by an individual, with no platform in between.',
  },
  newsletter: {
    search: 'Recurring updates, news digests, and curated broadcast content.',
  },
  promotional: {
    search: 'Marketing mail, sales pitches, and discount offers.',
  },
  notification: {
    search: 'Platform activity alerts and account notices such as billing or subscription problems.',
  },
  ticket: {
    search: 'Event tickets: theater, cinema, concerts, conferences.',
  },
  receipt: {
    search: 'Transaction receipts and payment confirmations.',
  },
  order: {
    search: 'Order confirmations, shipping updates, delivery tracking, returns and refunds.',
  },
  scheduling: {
    search: 'Calendar invites and booking confirmations — hotels, flights, restaurants, meetings, appointments.',
  },
  security_alert: {
    search: 'Login alerts, password changes, verification codes, and account recovery notices.',
  },
  terms: {
    search: 'Terms of service and privacy policy updates, and other legal or compliance notices.',
  },
} as const satisfies Record<string, { search: string }>

type EmailTypeUnion = keyof typeof EMAIL_TYPES

/** The taxonomy keys as a non-empty tuple, in canonical order. */
export const EMAIL_TYPE_VALUES = Object.keys(EMAIL_TYPES) as [EmailTypeUnion, ...EmailTypeUnion[]]
