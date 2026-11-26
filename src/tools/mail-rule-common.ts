// Shared plumbing for the mail-rule tool family: the rule-spec input
// shapes (create/preview take the whole spec, update takes each part
// optionally), the existing-mail policy shape, and the deps bundle the
// tools run against.

import { z } from 'zod'

import { LARGE_APPLY_THRESHOLD, type MailRulesApplier } from '../rules/apply.ts'
import {
  MATCH_VALUES,
  mailRuleActionsSchema,
  mailRuleConditionsShape,
  mailRuleLocalActionsSchema,
} from '../rules/rule.ts'
import { type MailRulesStore } from '../rules/store.ts'

export interface MailRuleToolDeps {
  applier: MailRulesApplier
  // Injectable clock so unit tests get deterministic timestamps.
  now?: () => string
  store: MailRulesStore
}

export const ruleTimestamp = (deps: MailRuleToolDeps): string => (deps.now ?? (() => new Date().toISOString()))()

// --- rule-spec input shapes -------------------------------------------------

export const ruleNameField = z
  .string()
  .min(1)
  .max(200)
  .describe('Optional human-readable rule name, e.g. "Archive GitHub Notifications".')

// Bare for update (where "not provided" must stay observable), defaulted
// for create/preview.
export const ruleMatchField = z
  .enum(MATCH_VALUES)
  .describe('How multiple conditions combine: "all" = every condition must match (AND), "any" = one is enough (OR).')

export const ruleMatchFieldWithDefault = ruleMatchField.default('all')

export const ruleConditionsField = z
  .object(mailRuleConditionsShape)
  .describe('When the rule fires; at least one is required. Matching is case-insensitive substring matching.')

export const ruleActionsField = mailRuleActionsSchema.describe(
  'What happens to a matching message — one or more actions, applied in order.'
)

// At Change, never send (src/access/levels.ts) a rule keeps mail inside the
// account, so the forward action is not offered.
export const ruleLocalActionsField = mailRuleLocalActionsSchema.describe(
  'What happens to a matching message: one or more actions, applied in order. Forwarding needs Everything access.'
)

// --- existing-mail policy ----------------------------------------------------

// Future automation and historical application are distinct operations: the
// rule itself only governs future deliveries; this policy opts a call into
// also touching mail that is already in the mailbox.
export const existingMailShape = {
  confirmLargeApply: z
    .boolean()
    .optional()
    .describe(
      `Must be true to apply to more than ${LARGE_APPLY_THRESHOLD} existing messages; preview_mail_rule first and let the user confirm the count.`
    ),
  mode: z
    .enum(['none', 'messages', 'conversations'])
    .default('none')
    .describe(
      'What existing mail to act on: "none" (default — future mail only), "messages", or "conversations" (whole threads).'
    ),
  scope: z
    .enum(['inbox', 'all'])
    .default('inbox')
    .describe('Where to look for existing matches: "inbox" (default) or "all" mail.'),
}

export const existingMailSchema = z.object(existingMailShape)
