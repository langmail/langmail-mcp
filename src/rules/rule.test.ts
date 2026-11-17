import { describe, expect, test } from "vitest";

import {
	generateSieveScript,
	type MailRule,
	mailRuleSchema,
	normalizeConditions,
	parseSieveScript,
	tagToKeywordSuffix,
} from "./rule.ts";

const rule = (overrides: Partial<MailRule> = {}): MailRule => ({
	actions: [{ type: "archive" }],
	conditions: { from: "notifications@github.example.com" },
	enabled: true,
	id: "rule-1a2b3c4d",
	match: "all",
	name: "Archive GitHub Notifications",
	...overrides,
});

describe("mailRuleSchema", () => {
	test("rejects a rule with no conditions or no actions", () => {
		expect(mailRuleSchema.safeParse(rule({ conditions: {} })).success).toBe(
			false
		);
		expect(mailRuleSchema.safeParse(rule({ actions: [] })).success).toBe(false);
		expect(mailRuleSchema.safeParse(rule()).success).toBe(true);
	});

	test("rejects control characters in condition strings", () => {
		expect(
			mailRuleSchema.safeParse(rule({ conditions: { subject: "line\nbreak" } }))
				.success
		).toBe(false);
	});

	test("rejects a tag that sanitizes to nothing and a non-email forward target", () => {
		expect(
			mailRuleSchema.safeParse(
				rule({ actions: [{ tag: "!!!", type: "addTag" }] })
			).success
		).toBe(false);
		expect(
			mailRuleSchema.safeParse(
				rule({ actions: [{ to: "not-an-address", type: "forward" }] })
			).success
		).toBe(false);
	});
});

describe("normalizeConditions", () => {
	test("drops hasAttachment:false but keeps true", () => {
		expect(normalizeConditions({ from: "x", hasAttachment: false })).toEqual({
			from: "x",
		});
		expect(normalizeConditions({ hasAttachment: true })).toEqual({
			hasAttachment: true,
		});
	});
});

describe("tagToKeywordSuffix", () => {
	test("mirrors the JMAP client label tag-id normalization", () => {
		expect(tagToKeywordSuffix("GitHub")).toBe("github");
		expect(tagToKeywordSuffix("Acme Corp")).toBe("acme-corp");
		expect(tagToKeywordSuffix("--Weird__Tag!!")).toBe("weird__tag");
	});

	test("returns null when nothing survives sanitization", () => {
		expect(tagToKeywordSuffix("!!!")).toBeNull();
	});
});

describe("generateSieveScript", () => {
	test("emits the require header, one metadata comment and one if-block per rule", () => {
		const script = generateSieveScript([
			rule(),
			rule({
				actions: [{ tag: "Finance", type: "addTag" }],
				conditions: { from: "stripe.com", subject: "invoice" },
				id: "rule-ffffffff",
				name: "Tag Stripe invoices",
			}),
		]);
		expect(script).toContain(
			'require ["fileinto", "imap4flags", "mailbox", "copy", "special-use", "body"];'
		);
		expect(script).toContain(
			'if allof (header :contains "from" "notifications@github.example.com") {'
		);
		expect(script).toContain(
			'  fileinto :specialuse "\\\\Archive" :create "Archive";'
		);
		expect(script).toContain(
			'if allof (header :contains "from" "stripe.com", header :contains "subject" "invoice") {'
		);
		expect(script).toContain('  addflag "$label:finance";');
	});

	test("match:any composes with anyof", () => {
		const script = generateSieveScript([
			rule({ conditions: { from: "a@x", to: "b@y" }, match: "any" }),
		]);
		expect(script).toContain(
			'if anyof (header :contains "from" "a@x", header :contains ["to", "cc"] "b@y") {'
		);
	});

	test("a disabled rule keeps its metadata but emits no executable block", () => {
		const script = generateSieveScript([rule({ enabled: false })]);
		expect(script).toContain("# langmail-rule ");
		expect(script).not.toContain("if allof");
		expect(script).not.toContain("fileinto :");
	});

	test("reorders flag mutations before filing so imap4flags apply to the filed copy, stop stays last", () => {
		const script = generateSieveScript([
			rule({
				actions: [
					{ type: "stopProcessing" },
					{ type: "archive" },
					{ tag: "github", type: "addTag" },
					{ type: "markRead" },
				],
			}),
		]);
		const tag = script.indexOf('addflag "$label:github";');
		const seen = script.indexOf('addflag "\\\\Seen";');
		const fileinto = script.indexOf('fileinto :specialuse "\\\\Archive"');
		const stop = script.indexOf("stop;");
		expect(tag).toBeGreaterThan(-1);
		expect(seen).toBeGreaterThan(tag);
		expect(fileinto).toBeGreaterThan(seen);
		expect(stop).toBeGreaterThan(fileinto);
	});

	test("renders every condition and action type", () => {
		const script = generateSieveScript([
			rule({
				actions: [
					{ mailbox: "Contracts", type: "move" },
					{ mailbox: "Backup", type: "copy" },
					{ tag: "Old", type: "removeTag" },
					{ type: "markUnread" },
					{ type: "flag" },
					{ type: "delete" },
					{ to: "oncall@example.com", type: "forward" },
				],
				conditions: {
					bodyContains: "wire transfer",
					from: "Acme Corp",
					hasAttachment: true,
					subject: "contract",
					to: "legal@example.com",
				},
			}),
		]);
		expect(script).toContain('header :contains "from" "Acme Corp"');
		expect(script).toContain(
			'header :contains ["to", "cc"] "legal@example.com"'
		);
		expect(script).toContain('header :contains "subject" "contract"');
		expect(script).toContain('body :contains "wire transfer"');
		expect(script).toContain(
			'header :contains "content-type" "multipart/mixed"'
		);
		expect(script).toContain('fileinto :create "Contracts";');
		expect(script).toContain('fileinto :copy :create "Backup";');
		expect(script).toContain('removeflag "$label:old";');
		expect(script).toContain('removeflag "\\\\Seen";');
		expect(script).toContain('addflag "\\\\Flagged";');
		expect(script).toContain(
			'fileinto :specialuse "\\\\Trash" :create "Trash";'
		);
		expect(script).toContain('redirect :copy "oncall@example.com";');
	});

	test("escapes quotes and backslashes in user-supplied strings", () => {
		const script = generateSieveScript([
			rule({
				actions: [{ mailbox: 'Sales "EMEA"', type: "move" }],
				conditions: { subject: 'quo"te \\ slash' },
			}),
		]);
		expect(script).toContain(
			'header :contains "subject" "quo\\"te \\\\ slash"'
		);
		expect(script).toContain('fileinto :create "Sales \\"EMEA\\"";');
	});
});

describe("parseSieveScript", () => {
	test("round-trips generate → parse for a mixed rule list including a disabled rule", () => {
		const rules = [
			rule({
				createdAt: "2026-07-22T10:00:00.000Z",
				updatedAt: "2026-07-22T11:00:00.000Z",
			}),
			rule({
				actions: [
					{ tag: "contracts", type: "addTag" },
					{ to: "oncall@example.com", type: "forward" },
					{ type: "markRead" },
				],
				conditions: { hasAttachment: true, subject: "contract" },
				enabled: false,
				id: "rule-99999999",
				match: "any",
				name: "Tag and forward contracts",
			}),
		];
		expect(parseSieveScript(generateSieveScript(rules))).toEqual(rules);
	});

	test("returns [] for an empty or foreign (hand-written) script", () => {
		expect(parseSieveScript("")).toEqual([]);
		expect(
			parseSieveScript('require ["fileinto"];\nif true { fileinto "X"; }\n')
		).toEqual([]);
	});

	test("skips malformed or invalid metadata lines but keeps the valid ones", () => {
		const good = rule();
		const script = [
			"# langmail-rule not-json{",
			`# langmail-rule ${JSON.stringify({ name: "no id or shape" })}`,
			`# langmail-rule ${JSON.stringify(good)}`,
		].join("\n");
		expect(parseSieveScript(script)).toEqual([good]);
	});
});
