import { describe, expect, test } from "vitest";

import { listMailRules } from "./list-mail-rules.ts";
import { fakeDeps, githubRule } from "./mail-rule-test-fixtures.ts";

describe("listMailRules", () => {
	test("points at create_mail_rule when no rules exist", async () => {
		const result = await listMailRules(fakeDeps(), "tok");
		expect(result.content[0]?.text).toContain("No mail rules configured");
	});

	test("renders id, name, enabled state, conditions, ordered actions, and timestamps per rule", async () => {
		const result = await listMailRules(
			fakeDeps([
				githubRule(),
				githubRule({
					actions: [
						{ tag: "contracts", type: "addTag" },
						{ to: "legal@example.com", type: "forward" },
					],
					conditions: { from: "Acme Corp", hasAttachment: true },
					createdAt: "2026-07-01T00:00:00.000Z",
					enabled: false,
					id: "rule-00000002",
					match: "all",
					name: "Acme contracts",
					updatedAt: "2026-07-10T00:00:00.000Z",
				}),
			]),
			"tok"
		);
		const txt = result.content[0]?.text ?? "";
		expect(txt).toContain("2 mail rule(s)");
		expect(txt).toContain("1. [rule-00000001] Archive GitHub Notifications");
		expect(txt).toContain(
			'when ALL of: sender contains "notifications@github.example.com"'
		);
		expect(txt).toContain("then: archive");
		expect(txt).toContain("2. [rule-00000002] Acme contracts (disabled)");
		expect(txt).toContain('sender contains "Acme Corp" AND has an attachment');
		expect(txt).toContain(
			'add tag "contracts", then forward a copy to legal@example.com'
		);
		expect(txt).toContain(
			"created: 2026-07-01T00:00:00.000Z, modified: 2026-07-10T00:00:00.000Z"
		);
	});
});
