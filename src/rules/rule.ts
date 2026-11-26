// The mail-rule domain model and its Sieve projection.
//
// A rule is a structured object the MCP client distills from the user's
// natural-language request ("whenever I receive an invoice from Stripe,
// move it to Finance"): matching conditions (composed with all/any), an
// ordered list of actions, a name, and an enabled flag. Rules are stored
// *in Stalwart itself* as one managed Sieve script (open protocol, no side
// database): each rule is serialized as a single-line JSON metadata comment
// followed by the generated Sieve block. The comments are the source of
// truth on read — `parseSieveScript` round-trips them — and the whole
// script is regenerated from the rule list on every write, so the Sieve
// code never drifts from the metadata. Consequence: hand-edits inside the
// managed script (including a corrupted metadata line) do not survive the
// next write; hand-written Sieve belongs in a *differently named* script.
//
// Rules govern FUTURE mail (Sieve runs at delivery). Applying a rule to
// existing mail is a separate, explicit operation — see apply.ts.

import { z } from 'zod'

import { toLabelKeyword } from '../jmap/index.ts'

// The name of the managed script in the user's Sieve script list. Scripts
// under any other name (e.g. hand-written via ManageSieve) are never
// rewritten — but note only one script can be *active* per account, so
// activating ours deactivates a previously active foreign script.
export const RULES_SCRIPT_NAME = 'langmail-rules'

const RULE_MARKER = '# langmail-rule '

// Sieve quoted strings may not contain raw control characters (RFC 5228
// §2.4.2 permits only CRLF, which we never emit inside a value), so reject
// them at the schema instead of failing the save with an opaque
// invalidScript error.
const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001F\u007F]*$/u

const conditionString = (max: number): z.ZodString =>
  z.string().min(1).max(max).regex(NO_CONTROL_CHARS_RE, {
    message: 'control characters are not allowed',
  })

// --- conditions --------------------------------------------------------------

// These `.describe()` strings are repeated verbatim in the indexed metadata of
// all three mail-rule tools (create/update/preview all embed the conditions and
// actions schema), so each one costs three times its length in tool search.
// Keep them to a single clause.
export const mailRuleConditionsShape = {
  bodyContains: conditionString(200).optional().describe('Message body contains this text.'),
  from: conditionString(200)
    .optional()
    .describe('Sender (From) contains this — an address, a domain like "github.com", or a name like "Acme Corp".'),
  hasAttachment: z
    .boolean()
    .optional()
    .describe('true matches messages that look like they carry an attachment (heuristic); false means "not set".'),
  subject: conditionString(200).optional().describe('Subject line contains this.'),
  to: conditionString(200).optional().describe('A To/Cc recipient contains this (address or name).'),
}

const conditionsSchema = z.object(mailRuleConditionsShape)

export type MailRuleConditions = z.infer<typeof conditionsSchema>

export const hasAnyCondition = (c: MailRuleConditions): boolean =>
  Boolean(c.from ?? c.to ?? c.subject ?? c.bodyContains ?? c.hasAttachment)

// hasAttachment:false means "not set" (see the .describe above); dropping it
// here keeps the stored metadata canonical.
export const normalizeConditions = (c: MailRuleConditions): MailRuleConditions => ({
  ...(c.from ? { from: c.from } : {}),
  ...(c.to ? { to: c.to } : {}),
  ...(c.subject ? { subject: c.subject } : {}),
  ...(c.bodyContains ? { bodyContains: c.bodyContains } : {}),
  ...(c.hasAttachment ? { hasAttachment: true } : {}),
})

// --- actions -------------------------------------------------------------------

// Mirror of the JMAP client label convention's tag-id normalization
// (originated in Bulwark; see email-sync's `sanitize_keyword`): lower →
// non-[a-z0-9_-] to '-' → collapse runs → trim. Keeping the algorithms in
// lockstep is what makes a rule's tag and a projected Gmail label with the
// same name collide into one chip.
export const tagToKeywordSuffix = (name: string): string | null => {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return slug.length > 0 ? slug : null
}

const tagString = conditionString(50).refine((t) => tagToKeywordSuffix(t) !== null, {
  message: 'tag must contain at least one letter, digit, "_" or "-"',
})

const mailboxString = conditionString(100)

// Ordered action list (RFC-agnostic, provider-portable vocabulary). Each
// entry is a discriminated object so new action types can grow fields
// without breaking the stored shape.
//
// The actions that stay inside the account, which is all a rule may do at
// Change, never send (src/access/levels.ts); `forward` is the one that reaches
// someone else.
const localActions = [
  z.object({ type: z.literal('archive') }).describe('Move it out of the Inbox into Archive.'),
  z.object({
    mailbox: mailboxString.describe('Target mailbox/folder name; created if missing.'),
    type: z.literal('move'),
  }),
  z.object({
    mailbox: mailboxString.describe('Target mailbox/folder name; created if missing.'),
    type: z.literal('copy'),
  }),
  z.object({
    tag: tagString.describe('Tag name, e.g. "GitHub"; slugified to a tag id ("Acme Corp" -> "acme-corp").'),
    type: z.literal('addTag'),
  }),
  z.object({ tag: tagString, type: z.literal('removeTag') }),
  z.object({ type: z.literal('markRead') }),
  z.object({ type: z.literal('markUnread') }),
  z.object({ type: z.literal('flag') }).describe('Flag/star it.'),
  z.object({ type: z.literal('delete') }).describe('Move it to Trash (not a permanent erase).'),
] as const

const forwardAction = z.object({
  to: z.email().describe('Forward a copy here; the original still lands in the mailbox.'),
  type: z.literal('forward'),
})

const stopProcessingAction = z
  .object({ type: z.literal('stopProcessing') })
  .describe('Skip any later rules for this message. Only useful as the last action.')

export const mailRuleActionSchema = z.discriminatedUnion('type', [...localActions, forwardAction, stopProcessingAction])

export const mailRuleLocalActionSchema = z.discriminatedUnion('type', [...localActions, stopProcessingAction])

export type MailRuleAction = z.infer<typeof mailRuleActionSchema>

export const mailRuleActionsSchema = z.array(mailRuleActionSchema).min(1).max(10)

export const mailRuleLocalActionsSchema = z.array(mailRuleLocalActionSchema).min(1).max(10)

export const forwardsMail = (rule: Pick<MailRule, 'actions'>): boolean =>
  rule.actions.some((action) => action.type === 'forward')

// --- rule ------------------------------------------------------------------------

export const MATCH_VALUES = ['all', 'any'] as const

// The stored shape: what the metadata comment carries and what
// list/update/delete round-trip.
export const mailRuleSchema = z.object({
  actions: mailRuleActionsSchema,
  conditions: conditionsSchema.refine(hasAnyCondition, { message: 'a rule needs at least one condition' }),
  createdAt: z.iso.datetime().optional(),
  enabled: z.boolean(),
  id: z.string().min(1).max(64),
  match: z.enum(MATCH_VALUES),
  name: conditionString(200).optional(),
  updatedAt: z.iso.datetime().optional(),
})

export type MailRule = z.infer<typeof mailRuleSchema>

// --- Sieve projection --------------------------------------------------------

// RFC 5228 §2.4.2 quoted strings: backslash and double-quote are the only
// characters that need escaping (control chars are rejected at the schema).
const sieveString = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

const conditionTests = (c: MailRuleConditions): string[] => {
  const tests: string[] = []
  if (c.from) {
    tests.push(`header :contains "from" ${sieveString(c.from)}`)
  }
  if (c.to) {
    tests.push(`header :contains ["to", "cc"] ${sieveString(c.to)}`)
  }
  if (c.subject) {
    tests.push(`header :contains "subject" ${sieveString(c.subject)}`)
  }
  if (c.bodyContains) {
    // RFC 5173 body test, default :text transform.
    tests.push(`body :contains ${sieveString(c.bodyContains)}`)
  }
  if (c.hasAttachment) {
    // Sieve has no first-class attachment test; multipart/mixed is the
    // conventional heuristic (attachments force that top-level type). The
    // schema description discloses the imprecision.
    tests.push('header :contains "content-type" "multipart/mixed"')
  }
  return tests
}

const actionCommand = (a: MailRuleAction): string | null => {
  switch (a.type) {
    case 'addTag': {
      const suffix = tagToKeywordSuffix(a.tag)
      return suffix ? `addflag ${sieveString(toLabelKeyword(suffix))};` : null
    }
    case 'archive':
      // :specialuse targets the account's real Archive folder by JMAP role
      // (RFC 8579), matching how the rest of the platform resolves it;
      // "Archive" is only the creation name if none exists yet.
      return 'fileinto :specialuse "\\\\Archive" :create "Archive";'
    case 'copy':
      // :copy keeps the message where it would otherwise go (RFC 3894).
      return `fileinto :copy :create ${sieveString(a.mailbox)};`
    case 'delete':
      return 'fileinto :specialuse "\\\\Trash" :create "Trash";'
    case 'flag':
      return 'addflag "\\\\Flagged";'
    case 'forward':
      // :copy keeps the local delivery; a forwarding rule must never be the
      // reason a message silently vanishes from the user's own mailbox.
      return `redirect :copy ${sieveString(a.to)};`
    case 'markRead':
      return 'addflag "\\\\Seen";'
    case 'markUnread':
      return 'removeflag "\\\\Seen";'
    case 'move':
      // :create files into the mailbox even if it doesn't exist yet, and
      // cancels the implicit keep — the message leaves the Inbox.
      return `fileinto :create ${sieveString(a.mailbox)};`
    case 'removeTag': {
      const suffix = tagToKeywordSuffix(a.tag)
      return suffix ? `removeflag ${sieveString(toLabelKeyword(suffix))};` : null
    }
    case 'stopProcessing':
      return 'stop;'
    default:
      return null
  }
}

const isFlagAction = (a: MailRuleAction): boolean =>
  a.type === 'addTag' || a.type === 'removeTag' || a.type === 'markRead' || a.type === 'markUnread' || a.type === 'flag'

// Emit a rule's actions as Sieve commands. Sieve's imap4flags model (RFC
// 5232) applies the *current* internal flag set at each keep/fileinto, so
// flag mutations are emitted before filing/redirect commands regardless of
// the listed order — that is what makes "archive, then tag, then mark read"
// mean what the user means. `stop` always goes last.
const actionCommands = (actions: MailRuleAction[]): string[] => {
  const flags = actions.filter(isFlagAction)
  const filings = actions.filter((a) => !(isFlagAction(a) || a.type === 'stopProcessing'))
  const stop = actions.some((a) => a.type === 'stopProcessing')
  const ordered = [...flags, ...filings, ...(stop ? [{ type: 'stopProcessing' } as const] : [])]
  return ordered.map(actionCommand).filter((c): c is string => c !== null)
}

const ruleBlock = (rule: MailRule): string => {
  const metadata = `${RULE_MARKER}${JSON.stringify(rule)}`
  if (!rule.enabled) {
    // Disabled rules keep their metadata (so list/update round-trip) but
    // contribute no executable code.
    return metadata
  }
  const combinator = rule.match === 'any' ? 'anyof' : 'allof'
  const tests = conditionTests(rule.conditions)
  const body = actionCommands(rule.actions)
    .map((c) => `  ${c}`)
    .join('\n')
  return [metadata, `if ${combinator} (${tests.join(', ')}) {`, body, '}'].join('\n')
}

// The full managed script. Deterministic output for a given rule list —
// saved verbatim, parsed back by `parseSieveScript`.
export const generateSieveScript = (rules: MailRule[]): string => {
  const header = [
    '# Langmail mail rules — generated from the metadata comments below.',
    '# Managed by the Langmail MCP server; do not edit by hand.',
    'require ["fileinto", "imap4flags", "mailbox", "copy", "special-use", "body"];',
  ]
  return [header.join('\n'), ...rules.map(ruleBlock)].join('\n\n').concat('\n')
}

// Recover the rule list from a stored script by re-parsing the metadata
// comments. Lines that fail to parse or validate are skipped — and because
// every save regenerates the whole script, a skipped rule is dropped on the
// next write (see the module header for why that is the contract).
export const parseSieveScript = (script: string): MailRule[] => {
  const rules: MailRule[] = []
  for (const line of script.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(RULE_MARKER)) {
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(trimmed.slice(RULE_MARKER.length))
    } catch {
      continue
    }
    const parsed = mailRuleSchema.safeParse(raw)
    if (parsed.success) {
      rules.push(parsed.data)
    }
  }
  return rules
}
