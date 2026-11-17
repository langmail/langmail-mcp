// list_mail_rules tool — show every persistent rule with its id, name,
// enabled state, conditions, actions, and timestamps, so the user can audit
// what runs against their inbox and the client can pick an id for
// update_mail_rule / delete_mail_rule.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { READ_ONLY } from "./annotations.ts";
import type { MailRuleToolDeps } from "./mail-rule-common.ts";
import { formatMailRule } from "./mail-rule-format.ts";
import { type ToolResult, textResult } from "./result.ts";

export const listMailRules = async (
	deps: MailRuleToolDeps,
	token: string
): Promise<ToolResult> => {
	const rules = await deps.store.load(token);
	if (rules.length === 0) {
		return textResult(
			"No mail rules configured. Create one with create_mail_rule (preview_mail_rule to dry-run it first)."
		);
	}
	const lines = rules.map((rule, i) => formatMailRule(i + 1, rule));
	return textResult(
		`${rules.length} mail rule(s) — enabled rules apply automatically to incoming messages:\n\n${lines.join("\n\n")}`
	);
};

// --- MCP registration ----------------------------------------------------

export const registerListMailRules = (
	server: McpServer,
	deps: MailRuleToolDeps,
	getToken: () => string
): void => {
	server.registerTool(
		"list_mail_rules",
		{
			annotations: READ_ONLY,
			description:
				"List the persistent mail rules with their ids, names, enabled state, conditions, " +
				'actions, and creation/modification times. Use this to answer "what rules do I ' +
				'have?", before updating or deleting a rule, or to check whether a similar rule ' +
				"already exists before creating a new one.",
			inputSchema: z.object({}),
			title: "List mail rules",
		},
		() => listMailRules(deps, getToken())
	);
};
