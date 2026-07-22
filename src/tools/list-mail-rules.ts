// list_mail_rules tool — show every persistent rule with its id, the
// plain-language description it was created with, and the structured
// conditions/actions, so the user can audit what runs against their inbox
// and the client can pick an id for delete_mail_rule.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { type MailRulesStore } from '../rules/store.ts'
import { formatMailRule } from './mail-rule-format.ts'
import { type ToolResult, textResult } from './result.ts'

export const listMailRules = async (store: MailRulesStore, token: string): Promise<ToolResult> => {
  const rules = await store.load(token)
  if (rules.length === 0) {
    return textResult('No mail rules configured. Create one with create_mail_rule.')
  }
  const lines = rules.map((rule, i) => formatMailRule(i + 1, rule))
  return textResult(
    `${rules.length} mail rule(s) — each applies automatically to incoming messages:\n\n${lines.join('\n\n')}`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerListMailRules = (server: McpServer, store: MailRulesStore, getToken: () => string): void => {
  server.registerTool(
    'list_mail_rules',
    {
      description:
        'List the persistent mail rules that automatically apply to incoming messages, with their ' +
        'ids, plain-language descriptions, conditions, and actions. Use this to answer "what rules ' +
        'do I have?", before deleting a rule, or to check whether a similar rule already exists ' +
        'before creating a new one.',
      inputSchema: {},
      title: 'List mail rules',
    },
    () => listMailRules(store, getToken())
  )
}
