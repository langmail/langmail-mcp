// delete_mail_rule tool — remove a persistent rule by id. The managed Sieve
// script is regenerated from the remaining rules, so the deleted rule stops
// applying immediately.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type MailRulesStore } from '../rules/store.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const deleteMailRuleShape = {
  ruleId: z
    .string()
    .min(1)
    .describe(
      'The id of the rule to delete, e.g. "rule-1a2b3c4d" — as returned by create_mail_rule or list_mail_rules.'
    ),
}

export const deleteMailRuleInput = z.object(deleteMailRuleShape)

export type DeleteMailRuleArgs = z.infer<typeof deleteMailRuleInput>

export const deleteMailRule = async (
  store: MailRulesStore,
  ctx: { args: DeleteMailRuleArgs; token: string }
): Promise<ToolResult> => {
  const rules = await store.load(ctx.token)
  const rule = rules.find((r) => r.id === ctx.args.ruleId)
  if (!rule) {
    return errorResult(`No mail rule with id ${ctx.args.ruleId}. Use list_mail_rules to see the current rules and ids.`)
  }
  await store.save(
    ctx.token,
    rules.filter((r) => r.id !== rule.id)
  )
  return textResult(`Deleted mail rule ${rule.id} ("${rule.description}"). It no longer applies to incoming messages.`)
}

// --- MCP registration ----------------------------------------------------

export const registerDeleteMailRule = (server: McpServer, store: MailRulesStore, getToken: () => string): void => {
  server.registerTool(
    'delete_mail_rule',
    {
      description:
        'Delete a persistent mail rule by id so it stops applying to future incoming messages. ' +
        'Find the id with list_mail_rules. To modify a rule, delete it and create a replacement ' +
        'with create_mail_rule. Messages the rule already acted on are not reverted.',
      inputSchema: deleteMailRuleShape,
      title: 'Delete mail rule',
    },
    (args) => deleteMailRule(store, { args: deleteMailRuleInput.parse(args), token: getToken() })
  )
}
