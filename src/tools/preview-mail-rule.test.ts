import { describe, expect, test } from "vitest";

import { fakeDeps } from "./mail-rule-test-fixtures.ts";
import { previewMailRule, previewMailRuleInput } from "./preview-mail-rule.ts";

const args = previewMailRuleInput.parse({
	actions: [{ type: "archive" }, { tag: "GitHub", type: "addTag" }],
	conditions: { from: "notifications@github.example.com" },
	name: "Archive GitHub Notifications",
});

describe("previewMailRule", () => {
	test("reports validity, the estimate, and the action summary without creating or applying anything", async () => {
		const deps = fakeDeps([], {
			estimate: { capped: false, conversations: 90, messages: 184 },
		});
		const result = await previewMailRule(deps, { args, token: "tok" });
		const txt = result.content[0]?.text ?? "";
		expect(result.isError).toBeUndefined();
		expect(txt).toContain("Rule is valid. Nothing was created or modified.");
		expect(txt).toContain(
			"Approximately 184 existing Inbox message(s) match (90 conversation(s))."
		);
		expect(txt).toContain('archive, then add tag "github"');
		expect(deps.saves).toBe(0);
		expect(deps.applies).toHaveLength(0);
	});

	test("an invalid rule is a result, not a tool error", async () => {
		const deps = fakeDeps();
		const result = await previewMailRule(deps, {
			args: { ...args, conditions: {} },
			token: "tok",
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Rule is INVALID");
		expect(deps.saves).toBe(0);
	});

	test("marks the estimate as a lower bound when the query window was hit", async () => {
		const deps = fakeDeps([], {
			estimate: { capped: true, conversations: 800, messages: 1000 },
		});
		const result = await previewMailRule(deps, {
			args: { ...args, existingMail: { mode: "messages", scope: "all" } },
			token: "tok",
		});
		expect(result.content[0]?.text).toContain("1000+");
	});

	test("warns about actions a backfill would skip and the attachment heuristic", async () => {
		const deps = fakeDeps();
		const result = await previewMailRule(deps, {
			args: {
				...args,
				actions: [{ to: "oncall@example.com", type: "forward" }],
				conditions: { from: "alerts@example.com", hasAttachment: true },
			},
			token: "tok",
		});
		const txt = result.content[0]?.text ?? "";
		expect(txt).toContain("skipped in a backfill: forward");
		expect(txt).toContain("Attachment detection");
	});
});
