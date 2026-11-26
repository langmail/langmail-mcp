// update_mail_rule tool — modify an existing rule in place while preserving
// its identity (id, createdAt). Only the provided parts change; conditions
// and actions are replaced wholesale when given (a partial merge of
// condition fields would be ambiguous about clearing). Optionally applies
// the updated actions to existing matching mail, same policy as create. At
// Change, never send a narrowed form offers no forward action and refuses a
// rule that already forwards.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { type AccessLevel, reachesOthers } from '../access/levels.ts'
import { type Narrowed, needsEverything } from '../access/narrowed.ts'
import { type ServerMode } from '../mode.ts'
import { LARGE_APPLY_THRESHOLD } from '../rules/apply.ts'
import {
  forwardsMail,
  hasAnyCondition,
  type MailRule,
  type MailRuleConditions,
  normalizeConditions,
} from '../rules/rule.ts'
import { ACCOUNT_WRITE, OUTWARD_WRITE } from './annotations.ts'
import {
  existingMailSchema,
  existingMailShape,
  type MailRuleToolDeps,
  ruleActionsField,
  ruleConditionsField,
  ruleLocalActionsField,
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

// The form an agent at Change, never send gets (src/access/levels.ts): every
// action but forward, so the rule keeps mail inside the account.
const updateLocalMailRuleShape = {
  ...updateMailRuleShape,
  actions: ruleLocalActionsField
    .optional()
    .describe('Replacement action list (replaces all current actions, in order). Forwarding needs Everything access.'),
}

// The cross-field rules both forms share.
const CONDITIONS_RULE = {
  check: (v: { conditions?: MailRuleConditions }): boolean =>
    v.conditions === undefined || hasAnyCondition(v.conditions),
  message: 'Replacement conditions need at least one of: from, to, subject, bodyContains, hasAttachment.',
}
const CHANGE_RULE = {
  check: (v: Partial<Record<'actions' | 'conditions' | 'enabled' | 'match' | 'name', unknown>>): boolean =>
    v.name !== undefined ||
    v.enabled !== undefined ||
    v.match !== undefined ||
    v.conditions !== undefined ||
    v.actions !== undefined,
  message: 'Provide at least one field to update: name, enabled, match, conditions, or actions.',
}

export const updateMailRuleInput = z
  .object(updateMailRuleShape)
  .refine(CONDITIONS_RULE.check, { message: CONDITIONS_RULE.message })
  .refine(CHANGE_RULE.check, { message: CHANGE_RULE.message })

export type UpdateMailRuleArgs = z.infer<typeof updateMailRuleInput>

export const updateLocalMailRuleInput = z
  .object(updateLocalMailRuleShape)
  .refine(CONDITIONS_RULE.check, { message: CONDITIONS_RULE.message })
  .refine(CHANGE_RULE.check, { message: CHANGE_RULE.message })

interface UpdateMailRuleContext {
  args: UpdateMailRuleArgs
  // Set at Change, never send: a rule that already forwards is refused.
  narrowed?: Narrowed
  token: string
}

export const updateMailRule = async (deps: MailRuleToolDeps, ctx: UpdateMailRuleContext): Promise<ToolResult> => {
  const { args, token } = ctx
  const existingMail = existingMailSchema.parse(args.existingMail ?? {})
  const rules = await deps.store.load(token)
  const index = rules.findIndex((r) => r.id === args.ruleId)
  const current = rules[index]
  if (!current) {
    return errorResult(`No mail rule with id ${args.ruleId}. Use list_mail_rules to see the current rules and ids.`)
  }
  if (ctx.narrowed && forwardsMail(current)) {
    return errorResult(
      needsEverything(
        `Mail rule ${args.ruleId} forwards mail to another address, so it cannot be changed at this access level. If the user wants the rule gone, delete_mail_rule removes it.`,
        'Changes to rules that forward mail',
        ctx.narrowed.mode
      )
    )
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

export const registerUpdateMailRule = (
  server: McpServer,
  deps: MailRuleToolDeps,
  getToken: () => string,
  access: AccessLevel,
  mode: ServerMode = 'hosted'
): void => {
  const full = reachesOthers(access)
  const input = full ? updateMailRuleInput : updateLocalMailRuleInput
  server.registerTool(
    'update_mail_rule',
    {
      annotations: full ? OUTWARD_WRITE : ACCOUNT_WRITE,
      description:
        'Update an existing mail rule while keeping its id and history: rename it, enable or ' +
        'disable it, change how conditions combine (match), or replace its conditions or ' +
        'actions. Only the provided fields change; conditions/actions replace the current ' +
        'ones wholesale when given. Optionally applies the updated rule to existing mail via ' +
        'existingMail (same confirmation policy as create_mail_rule). Find the id with ' +
        `list_mail_rules.${full ? '' : ' A rule that forwards mail needs Everything access.'}`,
      inputSchema: z.object(full ? updateMailRuleShape : updateLocalMailRuleShape),
      title: 'Update mail rule',
    },
    (args) => {
      const parsed = input.safeParse(args)
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((i) => i.message).join(' '))
      }
      return updateMailRule(deps, {
        args: parsed.data,
        token: getToken(),
        ...(full ? {} : { narrowed: { mode } }),
      })
    }
  )
}
