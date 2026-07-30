// delete_mail_rule tool — remove a persistent rule by id. The managed Sieve
// script is regenerated from the remaining rules, so the deleted rule stops
// applying immediately. Mail the rule already processed is not touched.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { type MailRuleToolDeps } from './mail-rule-common.ts'
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
  deps: MailRuleToolDeps,
  ctx: { args: DeleteMailRuleArgs; token: string }
): Promise<ToolResult> => {
  const rules = await deps.store.load(ctx.token)
  const rule = rules.find((r) => r.id === ctx.args.ruleId)
  if (!rule) {
    return errorResult(`No mail rule with id ${ctx.args.ruleId}. Use list_mail_rules to see the current rules and ids.`)
  }
  await deps.store.save(
    ctx.token,
    rules.filter((r) => r.id !== rule.id)
  )
  const title = rule.name ? ` ("${rule.name}")` : ''
  return textResult(
    `Deleted mail rule ${rule.id}${title}. It no longer applies to incoming messages; mail it already processed is unchanged.`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerDeleteMailRule = (server: McpServer, deps: MailRuleToolDeps, getToken: () => string): void => {
  server.registerTool(
    'delete_mail_rule',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Delete a persistent mail rule by id so it stops applying to future incoming messages. ' +
        'Messages the rule already acted on are not reverted. To pause a rule instead of ' +
        'removing it, use update_mail_rule with enabled: false. Find the id with ' +
        'list_mail_rules.',
      inputSchema: deleteMailRuleShape,
      title: 'Delete mail rule',
    },
    (args) => deleteMailRule(deps, { args: deleteMailRuleInput.parse(args), token: getToken() })
  )
}
