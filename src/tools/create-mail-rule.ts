// create_mail_rule tool — turn a natural-language "ongoing behavior" request
// ("whenever I receive an invoice from Stripe, move it to Finance") into a
// persistent server-side rule, optionally applying the same actions to
// existing mail in the same call. The MCP client does the language →
// structure distillation; this tool owns validation, id assignment,
// persistence into the managed Sieve script, and the explicit backfill.
//
// The persistent-vs-one-time distinction lives in the tool description: the
// client must only reach for this tool when the user expresses *future*
// behavior, and must clarify ambiguous requests instead of guessing.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { LARGE_APPLY_THRESHOLD } from '../rules/apply.ts'
import { hasAnyCondition, type MailRule, normalizeConditions } from '../rules/rule.ts'
import { ACCOUNT_WRITE } from './annotations.ts'
import {
  existingMailSchema,
  existingMailShape,
  type MailRuleToolDeps,
  ruleActionsField,
  ruleConditionsField,
  ruleMatchFieldWithDefault,
  ruleNameField,
  ruleTimestamp,
} from './mail-rule-common.ts'
import { formatApplyResult, formatMailRule } from './mail-rule-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const createMailRuleShape = {
  actions: ruleActionsField,
  conditions: ruleConditionsField,
  existingMail: z
    .object(existingMailShape)
    .optional()
    .describe(
      'Optionally also apply the actions to mail already in the mailbox. Omit (or mode "none") to affect future mail only — the safe default unless the user asked for a cleanup too.'
    ),
  match: ruleMatchFieldWithDefault,
  name: ruleNameField.optional(),
}

export const createMailRuleInput = z.object(createMailRuleShape).refine((v) => hasAnyCondition(v.conditions), {
  message: 'Provide at least one condition (from, to, subject, bodyContains, or hasAttachment).',
})

export type CreateMailRuleArgs = z.infer<typeof createMailRuleInput>

export interface CreateMailRuleContext {
  args: CreateMailRuleArgs
  token: string
}

// Short random id the model can echo back to update/delete_mail_rule;
// regenerated on the (astronomically unlikely) collision with an existing
// rule. Opaque to clients.
const newRuleId = (taken: Set<string>): string => {
  let id = `rule-${crypto.randomUUID().slice(0, 8)}`
  while (taken.has(id)) {
    id = `rule-${crypto.randomUUID().slice(0, 8)}`
  }
  return id
}

export const createMailRule = async (deps: MailRuleToolDeps, ctx: CreateMailRuleContext): Promise<ToolResult> => {
  const { args, token } = ctx
  const existingMail = existingMailSchema.parse(args.existingMail ?? {})
  const rules = await deps.store.load(token)
  const now = ruleTimestamp(deps)
  const rule: MailRule = {
    actions: args.actions,
    conditions: normalizeConditions(args.conditions),
    createdAt: now,
    enabled: true,
    id: newRuleId(new Set(rules.map((r) => r.id))),
    match: args.match,
    ...(args.name ? { name: args.name } : {}),
    updatedAt: now,
  }

  // The large-backfill guard runs BEFORE anything is written, so a denied
  // call leaves no half-created state.
  if (existingMail.mode !== 'none' && !existingMail.confirmLargeApply) {
    const estimate = await deps.applier.estimate(token, rule, existingMail.scope)
    if (estimate.messages > LARGE_APPLY_THRESHOLD) {
      return errorResult(
        `Nothing was created: ${estimate.messages}${estimate.capped ? '+' : ''} existing messages match, which exceeds the confirmation threshold of ${LARGE_APPLY_THRESHOLD}. Confirm the backfill with the user, then re-call with existingMail.confirmLargeApply: true — or with existingMail.mode "none" to create the rule for future mail only.`
      )
    }
  }

  await deps.store.save(token, [...rules, rule])
  const lines = [
    `Mail rule created — it now applies to future incoming messages${existingMail.mode === 'none' ? ' (existing messages are untouched)' : ''}:`,
    '',
    formatMailRule(rules.length + 1, rule),
  ]
  if (existingMail.mode !== 'none') {
    const applied = await deps.applier.applyToExisting(token, rule, existingMail.mode, existingMail.scope)
    lines.push('', formatApplyResult(applied))
  }
  lines.push(
    '',
    `Change it later with update_mail_rule("${rule.id}") or remove it with delete_mail_rule("${rule.id}").`
  )
  return textResult(lines.join('\n'))
}

// --- MCP registration ----------------------------------------------------

export const registerCreateMailRule = (server: McpServer, deps: MailRuleToolDeps, getToken: () => string): void => {
  server.registerTool(
    'create_mail_rule',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Create a persistent mail rule (filter) that automatically sorts, labels, archives or forwards ' +
        'FUTURE incoming messages until it is disabled or deleted. Use ONLY when the user expresses ongoing ' +
        'behavior — "automatically…", "from now on…", "whenever I receive…". If a request is ambiguous ' +
        'between a one-time cleanup and a standing rule (e.g. "archive all GitHub notifications"), ask which ' +
        'they mean first. Rules run server-side on arrival; every rule whose conditions match runs. Existing ' +
        'mail is untouched unless you pass existingMail (preview_mail_rule first — large backfills need ' +
        'explicit confirmation). Returns the created rule with its id.',
      inputSchema: createMailRuleShape,
      title: 'Create mail rule',
    },
    (args) => {
      // The SDK validated the field shapes; only the cross-field refine can
      // fail here. Surface it as a clean tool error, not a ZodError blob.
      const parsed = createMailRuleInput.safeParse(args)
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((i) => i.message).join(' '))
      }
      return createMailRule(deps, { args: parsed.data, token: getToken() })
    }
  )
}
