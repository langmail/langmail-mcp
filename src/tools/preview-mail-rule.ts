// preview_mail_rule tool — validate a proposed rule and estimate its blast
// radius WITHOUT creating, modifying, or touching anything. This is the
// step that lets a client show the user "~184 existing messages would be
// affected" before committing, and the prerequisite for confirming a large
// backfill on create/update.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { skippedActionTypes } from "../rules/apply.ts";
import {
	hasAnyCondition,
	type MailRule,
	normalizeConditions,
} from "../rules/rule.ts";
import { READ_ONLY } from "./annotations.ts";
import {
	existingMailSchema,
	existingMailShape,
	type MailRuleToolDeps,
	ruleActionsField,
	ruleConditionsField,
	ruleMatchFieldWithDefault,
	ruleNameField,
} from "./mail-rule-common.ts";
import {
	describeActions,
	describeConditions,
	formatEstimate,
} from "./mail-rule-format.ts";
import { type ToolResult, textResult } from "./result.ts";

const previewMailRuleShape = {
	actions: ruleActionsField,
	conditions: ruleConditionsField,
	existingMail: z
		.object(existingMailShape)
		.optional()
		.describe(
			"The existing-mail policy being considered — its scope decides where matches are counted (default: inbox)."
		),
	match: ruleMatchFieldWithDefault,
	name: ruleNameField.optional(),
};

export const previewMailRuleInput = z.object(previewMailRuleShape);

export type PreviewMailRuleArgs = z.infer<typeof previewMailRuleInput>;

export const previewMailRule = async (
	deps: MailRuleToolDeps,
	ctx: { args: PreviewMailRuleArgs; token: string }
): Promise<ToolResult> => {
	const { args, token } = ctx;
	// Validity is part of the preview RESULT, not a tool error — the client
	// is explicitly asking "would this work?".
	if (!hasAnyCondition(args.conditions)) {
		return textResult(
			"Rule is INVALID: provide at least one condition (from, to, subject, bodyContains, or hasAttachment). Nothing was created."
		);
	}
	const existingMail = existingMailSchema.parse(args.existingMail ?? {});
	const rule: MailRule = {
		actions: args.actions,
		conditions: normalizeConditions(args.conditions),
		enabled: true,
		id: "preview",
		match: args.match,
		...(args.name ? { name: args.name } : {}),
	};
	const estimate = await deps.applier.estimate(token, rule, existingMail.scope);

	const warnings: string[] = [];
	const skipped = skippedActionTypes(rule.actions);
	if (skipped.length > 0) {
		warnings.push(
			`These actions apply to future mail only and would be skipped in a backfill: ${skipped.join(", ")}.`
		);
	}
	if (rule.conditions.hasAttachment) {
		warnings.push(
			"Attachment detection for future mail is heuristic; some signed or inline-attachment messages may not match."
		);
	}

	const lines = [
		"Rule is valid. Nothing was created or modified.",
		"",
		`Would match when ${rule.match === "any" ? "ANY" : "ALL"} of: ${describeConditions(rule.conditions, rule.match)}`,
		`Would then: ${describeActions(rule.actions)}`,
		"",
		formatEstimate(estimate, existingMail.scope),
	];
	if (warnings.length > 0) {
		lines.push("", `Warnings:\n- ${warnings.join("\n- ")}`);
	}
	lines.push(
		"",
		"To install it, call create_mail_rule with the same rule (add existingMail to also process the existing matches)."
	);
	return textResult(lines.join("\n"));
};

// --- MCP registration ----------------------------------------------------

export const registerPreviewMailRule = (
	server: McpServer,
	deps: MailRuleToolDeps,
	getToken: () => string
): void => {
	server.registerTool(
		"preview_mail_rule",
		{
			annotations: READ_ONLY,
			description:
				"Validate a proposed mail rule and estimate its effect WITHOUT creating or changing " +
				"anything — returns whether the rule is valid, warnings, how many existing messages " +
				"and conversations currently match, and a plain-language summary of what would happen. " +
				"Use this before create_mail_rule when the user should see the blast radius first, and " +
				"always before applying a rule to existing mail (large backfills require the count to " +
				"be confirmed). This tool never modifies mail and never installs a rule.",
			inputSchema: z.object(previewMailRuleShape),
			title: "Preview mail rule",
		},
		(args) =>
			previewMailRule(deps, {
				args: previewMailRuleInput.parse(args),
				token: getToken(),
			})
	);
};
