// update_mail_rule tool — modify an existing rule in place while preserving
// its identity (id, createdAt). Only the provided parts change; conditions
// and actions are replaced wholesale when given (a partial merge of
// condition fields would be ambiguous about clearing). Optionally applies
// the updated actions to existing matching mail, same policy as create.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { LARGE_APPLY_THRESHOLD } from '../rules/apply.ts'
import { hasAnyCondition, type MailRule, normalizeConditions } from '../rules/rule.ts'
import {
  existingMailSchema,
  existingMailShape,
  type MailRuleToolDeps,
  ruleActionsField,
  ruleConditionsField,
  ruleMatchField,
  ruleNameField,
  ruleTimestamp,
} from './mail-rule-common.ts'
import { formatApplyResult, formatMailRule } from './mail-rule-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const updateMailRuleShape = {
  actions: ruleActionsField.optional().describe('Replacement action list (replaces all current actions, in order).'),
  conditions: ruleConditionsField
    .optional()
    .describe('Replacement conditions (replace all current conditions; at least one required when given).'),
  enabled: z.boolean().optional().describe('Enable (true) or disable (false) the rule without deleting it.'),
  existingMail: z
    .object(existingMailShape)
    .optional()
    .describe('Optionally apply the UPDATED rule to existing mail after saving, same policy as create_mail_rule.'),
  match: ruleMatchField.optional(),
  name: ruleNameField.optional(),
  ruleId: z
    .string()
    .min(1)
    .describe('The id of the rule to update, as returned by create_mail_rule or list_mail_rules.'),
}

export const updateMailRuleInput = z
  .object(updateMailRuleShape)
  .refine((v) => v.conditions === undefined || hasAnyCondition(v.conditions), {
    message: 'Replacement conditions need at least one of: from, to, subject, bodyContains, hasAttachment.',
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.enabled !== undefined ||
      v.match !== undefined ||
      v.conditions !== undefined ||
      v.actions !== undefined,
    { message: 'Provide at least one field to update: name, enabled, match, conditions, or actions.' }
  )

export type UpdateMailRuleArgs = z.infer<typeof updateMailRuleInput>

export const updateMailRule = async (
  deps: MailRuleToolDeps,
  ctx: { args: UpdateMailRuleArgs; token: string }
): Promise<ToolResult> => {
  const { args, token } = ctx
  const existingMail = existingMailSchema.parse(args.existingMail ?? {})
  const rules = await deps.store.load(token)
  const index = rules.findIndex((r) => r.id === args.ruleId)
  const current = rules[index]
  if (!current) {
    return errorResult(`No mail rule with id ${args.ruleId}. Use list_mail_rules to see the current rules and ids.`)
  }

  const updated: MailRule = {
    ...current,
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
    ...(args.match === undefined ? {} : { match: args.match }),
    ...(args.conditions === undefined ? {} : { conditions: normalizeConditions(args.conditions) }),
    ...(args.actions === undefined ? {} : { actions: args.actions }),
    updatedAt: ruleTimestamp(deps),
  }

  // Same pre-write guard as create: a denied large backfill changes nothing.
  if (existingMail.mode !== 'none' && !existingMail.confirmLargeApply) {
    const estimate = await deps.applier.estimate(token, updated, existingMail.scope)
    if (estimate.messages > LARGE_APPLY_THRESHOLD) {
      return errorResult(
        `Nothing was updated: ${estimate.messages}${estimate.capped ? '+' : ''} existing messages match, which exceeds the confirmation threshold of ${LARGE_APPLY_THRESHOLD}. Confirm the backfill with the user, then re-call with existingMail.confirmLargeApply: true — or with existingMail.mode "none" to update the rule without touching existing mail.`
      )
    }
  }

  const next = [...rules]
  next[index] = updated
  await deps.store.save(token, next)

  const lines = ['Mail rule updated:', '', formatMailRule(index + 1, updated)]
  if (existingMail.mode !== 'none') {
    const applied = await deps.applier.applyToExisting(token, updated, existingMail.mode, existingMail.scope)
    lines.push('', formatApplyResult(applied))
  }
  return textResult(lines.join('\n'))
}

// --- MCP registration ----------------------------------------------------

export const registerUpdateMailRule = (server: McpServer, deps: MailRuleToolDeps, getToken: () => string): void => {
  server.registerTool(
    'update_mail_rule',
    {
      description:
        'Update an existing mail rule while keeping its id and history: rename it, enable or ' +
        'disable it, change how conditions combine (match), or replace its conditions or ' +
        'actions. Only the provided fields change; conditions/actions replace the current ' +
        'ones wholesale when given. Optionally applies the updated rule to existing mail via ' +
        'existingMail (same confirmation policy as create_mail_rule). Find the id with ' +
        'list_mail_rules.',
      inputSchema: updateMailRuleShape,
      title: 'Update mail rule',
    },
    (args) => {
      const parsed = updateMailRuleInput.safeParse(args)
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((i) => i.message).join(' '))
      }
      return updateMailRule(deps, { args: parsed.data, token: getToken() })
    }
  )
}
