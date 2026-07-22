// The mail-rule domain model and its Sieve projection.
//
// A rule is a structured (conditions → actions) object the MCP client
// distills from the user's natural-language request ("whenever I receive an
// invoice from Stripe, move it to Finance"). Rules are stored *in Stalwart
// itself* as one managed Sieve script (open protocol, no side database):
// each rule is serialized as a single-line JSON metadata comment followed
// by the generated Sieve block. The comments are the source of truth on
// read — `parseSieveScript` round-trips them — and the whole script is
// regenerated from the rule list on every write, so the Sieve code never
// drifts from the metadata.

import { z } from 'zod'

// The name of the managed script in the user's Sieve script list. Scripts
// under any other name (e.g. hand-written via ManageSieve) are left alone.
export const RULES_SCRIPT_NAME = 'langmail-rules'

const RULE_MARKER = '# langmail-rule '

// --- schema ----------------------------------------------------------------

// Raw shapes are exported for the MCP tool inputSchema; the cross-field
// "at least one" rules live on the parsing schemas below.
export const mailRuleConditionsShape = {
  from: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Match when the sender (From header) contains this substring — an address, a domain like "github.com", or a display name like "Acme Corp".'
    ),
  hasAttachment: z.literal(true).optional().describe('Match only messages that carry an attachment.'),
  subject: z.string().min(1).max(200).optional().describe('Match when the subject line contains this substring.'),
  to: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Match when a To/Cc recipient contains this substring (address or display name).'),
}

export const mailRuleActionsShape = {
  addTags: z
    .array(z.string().min(1).max(50))
    .min(1)
    .max(5)
    .optional()
    .describe(
      'Tag names to apply, e.g. ["github"]. Slugified to lowercase tag ids ("Acme Corp" -> "acme-corp") and rendered as label chips in the webmail.'
    ),
  forwardTo: z
    .email()
    .optional()
    .describe('Forward a copy of the message to this address; the original still lands in the mailbox.'),
  markRead: z.literal(true).optional().describe('Mark the message as read on arrival.'),
  moveTo: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'File the message into this mailbox/folder instead of the Inbox, creating it if missing. Use "Archive" to auto-archive.'
    ),
}

const conditionsSchema = z.object(mailRuleConditionsShape)
const actionsSchema = z.object(mailRuleActionsShape)

export const hasAnyCondition = (c: z.infer<typeof conditionsSchema>): boolean =>
  Boolean(c.from ?? c.subject ?? c.to ?? c.hasAttachment)

export const hasAnyAction = (a: z.infer<typeof actionsSchema>): boolean =>
  Boolean(a.moveTo ?? a.forwardTo ?? a.markRead ?? (a.addTags && a.addTags.length > 0))

// The stored shape: what the metadata comment carries and what list/delete
// round-trip. `description` is the client's plain-language restatement of
// the rule, shown back to the user in list_mail_rules.
export const mailRuleSchema = z.object({
  actions: actionsSchema.refine(hasAnyAction, { message: 'a rule needs at least one action' }),
  conditions: conditionsSchema.refine(hasAnyCondition, { message: 'a rule needs at least one condition' }),
  description: z.string().min(1).max(500),
  id: z.string().min(1).max(64),
})

export type MailRule = z.infer<typeof mailRuleSchema>
export type MailRuleConditions = MailRule['conditions']
export type MailRuleActions = MailRule['actions']

// --- Sieve projection --------------------------------------------------------

// RFC 5228 §2.4.2 quoted strings: backslash and double-quote are the only
// characters that need escaping.
const sieveString = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

// Mirror of Bulwark's tag-id normalization (see email-sync's
// `sanitize_keyword`): lower → non-[a-z0-9_-] to '-' → collapse runs → trim.
// Keeping the algorithms in lockstep is what makes a rule's tag and a
// user-defined webmail tag with the same name collide into one chip.
export const tagToKeywordSuffix = (name: string): string | null => {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return slug.length > 0 ? slug : null
}

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
  if (c.hasAttachment) {
    // Sieve has no first-class attachment test; multipart/mixed is the
    // conventional heuristic (attachments force that top-level type).
    tests.push('header :contains "content-type" "multipart/mixed"')
  }
  return tests
}

const actionCommands = (a: MailRuleActions): string[] => {
  const commands: string[] = []
  // imap4flags: addflag mutates the flag set applied by the keep/fileinto
  // that runs *afterwards*, so flag commands must precede fileinto.
  if (a.markRead) {
    commands.push('addflag "\\\\Seen";')
  }
  for (const tag of a.addTags ?? []) {
    const suffix = tagToKeywordSuffix(tag)
    if (suffix) {
      commands.push(`addflag ${sieveString(`$label:${suffix}`)};`)
    }
  }
  if (a.moveTo) {
    // :create files into the mailbox even if it doesn't exist yet, and
    // cancels the implicit keep — the message leaves the Inbox.
    commands.push(`fileinto :create ${sieveString(a.moveTo)};`)
  }
  if (a.forwardTo) {
    // :copy keeps the local delivery; a forwarding rule must never be the
    // reason a message silently vanishes from the user's own mailbox.
    commands.push(`redirect :copy ${sieveString(a.forwardTo)};`)
  }
  return commands
}

const ruleBlock = (rule: MailRule): string => {
  const tests = conditionTests(rule.conditions)
  const body = actionCommands(rule.actions)
    .map((c) => `  ${c}`)
    .join('\n')
  return [`${RULE_MARKER}${JSON.stringify(rule)}`, `if allof (${tests.join(', ')}) {`, body, '}'].join('\n')
}

// The full managed script. Deterministic output for a given rule list —
// saved verbatim, parsed back by `parseSieveScript`.
export const generateSieveScript = (rules: MailRule[]): string => {
  const header = [
    '# Langmail mail rules — generated from the metadata comments below.',
    '# Managed by the Langmail MCP server; do not edit by hand.',
    'require ["fileinto", "imap4flags", "mailbox", "copy"];',
  ]
  return [header.join('\n'), ...rules.map(ruleBlock)].join('\n\n').concat('\n')
}

// Recover the rule list from a stored script by re-parsing the metadata
// comments. Lines that fail to parse or validate are skipped — a rule the
// server can't understand is invisible rather than fatal.
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
