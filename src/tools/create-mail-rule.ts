// create_mail_rule tool — turn a natural-language "ongoing behavior" request
// ("whenever I receive an invoice from Stripe, move it to Finance") into a
// persistent server-side rule. The MCP client does the language → structure
// distillation; this tool owns validation, id assignment, and persistence
// into the managed Sieve script (rules/store.ts).
//
// The persistent-vs-one-time distinction lives in the tool description: the
// client must only reach for this tool when the user expresses *future*
// behavior, and must clarify ambiguous requests instead of guessing.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  hasAnyAction,
  hasAnyCondition,
  type MailRule,
  mailRuleActionsShape,
  mailRuleConditionsShape,
} from '../rules/rule.ts'
import { type MailRulesStore } from '../rules/store.ts'
import { formatMailRule } from './mail-rule-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const createMailRuleShape = {
  actions: z
    .object(mailRuleActionsShape)
    .describe('What to do with a matching message. At least one action is required; all listed actions run.'),
  conditions: z
    .object(mailRuleConditionsShape)
    .describe(
      'When the rule fires. At least one condition is required; multiple conditions must ALL match (AND). Matching is case-insensitive substring matching on message headers.'
    ),
  description: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'The rule restated in plain language from the user\'s perspective, e.g. "Automatically archive all GitHub notifications". Shown back to the user by list_mail_rules.'
    ),
}

// Cross-field "at least one condition / action" refines — enforced when the
// handler parses, surfaced as clean tool errors.
export const createMailRuleInput = z
  .object(createMailRuleShape)
  .refine((v) => hasAnyCondition(v.conditions), {
    message: 'Provide at least one condition (from, to, subject, or hasAttachment).',
  })
  .refine((v) => hasAnyAction(v.actions), {
    message: 'Provide at least one action (moveTo, addTags, markRead, or forwardTo).',
  })

export type CreateMailRuleArgs = z.infer<typeof createMailRuleInput>

export interface CreateMailRuleContext {
  args: CreateMailRuleArgs
  token: string
}

// Short random id the model can echo back to delete_mail_rule; regenerated
// on the (astronomically unlikely) collision with an existing rule.
const newRuleId = (taken: Set<string>): string => {
  let id = `rule-${crypto.randomUUID().slice(0, 8)}`
  while (taken.has(id)) {
    id = `rule-${crypto.randomUUID().slice(0, 8)}`
  }
  return id
}

export const createMailRule = async (store: MailRulesStore, ctx: CreateMailRuleContext): Promise<ToolResult> => {
  const rules = await store.load(ctx.token)
  const rule: MailRule = {
    actions: ctx.args.actions,
    conditions: ctx.args.conditions,
    description: ctx.args.description,
    id: newRuleId(new Set(rules.map((r) => r.id))),
  }
  await store.save(ctx.token, [...rules, rule])
  return textResult(
    `Mail rule created — it now applies to future incoming messages (existing messages are untouched):\n\n${formatMailRule(
      rules.length + 1,
      rule
    )}\n\nDelete it anytime with delete_mail_rule("${rule.id}").`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerCreateMailRule = (server: McpServer, store: MailRulesStore, getToken: () => string): void => {
  server.registerTool(
    'create_mail_rule',
    {
      description:
        'Create a persistent mail rule that automatically applies to FUTURE incoming messages, ' +
        'until it is deleted. Use ONLY when the user expresses ongoing behavior — "automatically…", ' +
        '"from now on…", "whenever I receive…", "apply X to every future…". It does nothing to ' +
        'messages already in the mailbox. If a request is ambiguous between a one-time action on ' +
        'existing mail and a standing rule (e.g. "archive all GitHub notifications"), ask the user ' +
        'which they mean before calling this. Rules run server-side on arrival, independent of any ' +
        'client. To change a rule later, delete it (delete_mail_rule) and create a replacement. ' +
        'Returns the created rule with its id.',
      inputSchema: createMailRuleShape,
      title: 'Create mail rule',
    },
    (args) => {
      // The SDK validated the field shapes; only the cross-field refines can
      // fail here. Surface them as a clean tool error, not a ZodError blob.
      const parsed = createMailRuleInput.safeParse(args)
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((i) => i.message).join(' '))
      }
      return createMailRule(store, { args: parsed.data, token: getToken() })
    }
  )
}
