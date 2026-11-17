// E2E for the mail-rules tools against a REAL Stalwart: every tool
// (preview, create, list, update, delete) is driven end to end through the
// live store (SieveScript blobs over JMAP) and the live existing-mail
// applier (Email/query + Email/set). Because SieveScript/set runs
// Stalwart's Sieve compiler, the create/update tests also prove the
// generated scripts are valid Sieve — including a kitchen-sink rule
// covering every condition and action type.
//
// Seeding is deterministic and in-process: raw RFC 5322 messages are
// uploaded and Email/import-ed into the Inbox (no SMTP timing).
//
// The tools receive the account's Basic app-password credential as their
// token, the complete Authorization header, exactly as the server hands it
// to them. Nothing is pinned or stubbed between the tools and Stalwart.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	blobDownload,
	emailGet,
	emailQueryFilter,
	makeJmapLive,
	sieveScriptList,
} from "../src/jmap/index.ts";
import { makeLiveApplyIo, makeMailRulesApplier } from "../src/rules/apply.ts";
import { RULES_SCRIPT_NAME } from "../src/rules/rule.ts";
import { makeLiveSieveIo, makeMailRulesStore } from "../src/rules/store.ts";
import {
	createMailRule,
	createMailRuleInput,
} from "../src/tools/create-mail-rule.ts";
import { deleteMailRule } from "../src/tools/delete-mail-rule.ts";
import { listMailRules } from "../src/tools/list-mail-rules.ts";
import type { MailRuleToolDeps } from "../src/tools/mail-rule-common.ts";
import {
	previewMailRule,
	previewMailRuleInput,
} from "../src/tools/preview-mail-rule.ts";
import {
	updateMailRule,
	updateMailRuleInput,
} from "../src/tools/update-mail-rule.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	mailboxId,
	openMailSession,
} from "./support/mail.ts";
import { untilIndexed } from "./support/wait.ts";

const GITHUB_SENDER = "notifications@github.example.com";
// Other suites load the same server, so indexing can lag well past its
// usual fraction of a second.
const INDEX_TIMEOUT_MS = 30_000;

const RULE_ID_RE = /\[(rule-[0-9a-f]{8})\]/u;
const KITCHEN_RULE_ID_RE = /\[(rule-[0-9a-f]{8})\] Kitchen sink/u;

live(
	"mail rules against live Stalwart — preview/create/list/update/delete",
	() => {
		const run = Date.now();
		let address: string;
		let authorization: string;
		// What the tools receive: the complete Authorization header value.
		let TOKEN: string;
		let accountId: string;
		let apiUrl: string;
		let downloadUrl: string;
		let inboxId: string;
		let deps: MailRuleToolDeps;
		let githubIds: string[] = [];
		let otherId: string;

		const message = (subject: string, from: string, index: number): string =>
			[
				`From: Notifications <${from}>`,
				`To: ${address}`,
				`Subject: ${subject}`,
				`Message-ID: <${index}-${run}@mcp-rules-e2e>`,
				"Date: Tue, 21 Jul 2026 10:00:00 +0000",
				"",
				`Body of ${subject}.`,
			].join("\r\n");

		const seed = (
			session: MailSession,
			subject: string,
			from: string,
			index: number
		): Promise<string> =>
			importEmail(session, {
				raw: message(subject, from, index),
				receivedAt: new Date("2026-07-21T10:00:00Z"),
			});

		const managedScript = async (): Promise<
			{ blobId: string; id: string; isActive: boolean } | undefined
		> => {
			const scripts = await sieveScriptList({
				accountId,
				apiUrl,
				authorization,
			});
			return scripts.find((s) => s.name === RULES_SCRIPT_NAME);
		};

		const scriptContent = async (blobId: string): Promise<string> => {
			const res = await blobDownload({
				accountId,
				authorization,
				blobId,
				downloadUrl,
				name: "rules.sieve",
				type: "application/sieve",
			});
			return res.text();
		};

		beforeAll(async () => {
			const account = await createAccount({
				localPart: uniqueLocalPart("mcp-rules-e2e"),
			});
			address = account.address;
			authorization = account.authorization;
			TOKEN = account.authorization;

			const session = await openMailSession(authorization);
			apiUrl = session.apiUrl;
			downloadUrl = session.downloadUrl;
			const jmapLive = makeJmapLive(ADMIN_URL);
			accountId = await jmapLive.resolveAccountId(authorization);
			expect(accountId).toBe(session.accountId);

			const ctx = { accountId, apiUrl, authorization };
			inboxId = await mailboxId(session, "inbox");

			githubIds = [
				await seed(session, "PR #1 opened", GITHUB_SENDER, 1),
				await seed(session, "PR #2 opened", GITHUB_SENDER, 2),
			];
			otherId = await seed(
				session,
				"Lunch on Friday?",
				"friend@example.com",
				3
			);
			// The preview and the backfill both query the index, so the seed is awaited.
			await untilIndexed(
				() =>
					emailQueryFilter({
						...ctx,
						filter: { from: GITHUB_SENDER },
						limit: 10,
					}),
				(found) => githubIds.every((id) => found.includes(id)),
				"the seeded GitHub notifications",
				INDEX_TIMEOUT_MS
			);

			// The live deps, wired as the server wires them.
			deps = {
				applier: makeMailRulesApplier(makeLiveApplyIo(jmapLive)),
				store: makeMailRulesStore(makeLiveSieveIo(jmapLive)),
			};
		});

		// Throwaway principal; destroying it also drops its mail data.
		afterAll(destroyCreatedAccounts);

		const githubRuleArgs = {
			actions: [
				{ type: "archive" as const },
				{ tag: "GitHub", type: "addTag" as const },
				{ type: "markRead" as const },
			],
			conditions: { from: GITHUB_SENDER },
			name: "Archive GitHub Notifications",
		};

		test("preview_mail_rule estimates the seeded matches and installs nothing", async () => {
			const result = await previewMailRule(deps, {
				args: previewMailRuleInput.parse({
					...githubRuleArgs,
					existingMail: { mode: "messages", scope: "inbox" },
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain("Rule is valid.");
			expect(txt).toContain(
				"Approximately 2 existing Inbox message(s) match (2 conversation(s))."
			);
			expect(await managedScript()).toBeUndefined();
		});

		test("create_mail_rule installs an active Sieve script and backfills existing Inbox mail", async () => {
			const result = await createMailRule(deps, {
				args: createMailRuleInput.parse({
					...githubRuleArgs,
					existingMail: { mode: "messages", scope: "inbox" },
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain("Mail rule created");
			expect(txt).toContain(
				"Applied to existing mail: 2 messages matched, 2 modified."
			);

			// Stalwart accepted (= compiled) and activated the generated script.
			const script = await managedScript();
			expect(script).toBeDefined();
			expect(script?.isActive).toBe(true);
			const content = await scriptContent(script?.blobId ?? "");
			expect(content).toContain("# langmail-rule ");
			expect(content).toContain(
				'fileinto :specialuse "\\\\Archive" :create "Archive";'
			);

			// The backfill really moved/tagged/read the matching messages …
			const patched = await emailGet({
				accountId,
				apiUrl,
				authorization,
				ids: githubIds,
			});
			for (const email of patched) {
				expect(email.keywords?.["$label:github"]).toBe(true);
				expect(email.keywords?.$seen).toBe(true);
				expect(email.mailboxIds?.[inboxId]).toBeUndefined();
			}
			// … and left the non-matching message alone.
			const [other] = await emailGet({
				accountId,
				apiUrl,
				authorization,
				ids: [otherId],
			});
			expect(other?.mailboxIds?.[inboxId]).toBe(true);
			expect(other?.keywords?.["$label:github"]).toBeUndefined();
		});

		test("list_mail_rules shows the installed rule with its id and state", async () => {
			const result = await listMailRules(deps, TOKEN);
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain("1 mail rule(s)");
			expect(txt).toContain("Archive GitHub Notifications");
			expect(txt).toMatch(RULE_ID_RE);
			expect(txt).toContain(`sender contains "${GITHUB_SENDER}"`);
		});

		test("update_mail_rule disables the rule in place and the script drops its executable block", async () => {
			const listed = (await listMailRules(deps, TOKEN)).content[0]?.text ?? "";
			const ruleId = listed.match(RULE_ID_RE)?.[1] as string;

			const result = await updateMailRule(deps, {
				args: updateMailRuleInput.parse({
					enabled: false,
					name: "GitHub (paused)",
					ruleId,
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("GitHub (paused) (disabled)");

			const script = await managedScript();
			const content = await scriptContent(script?.blobId ?? "");
			expect(content).toContain('"enabled":false');
			expect(content).not.toContain("if allof");

			const relisted =
				(await listMailRules(deps, TOKEN)).content[0]?.text ?? "";
			expect(relisted).toContain("GitHub (paused) (disabled)");
		});

		test("a kitchen-sink rule with every condition and action type compiles on the server", async () => {
			const result = await createMailRule(deps, {
				args: createMailRuleInput.parse({
					actions: [
						{ tag: "Kitchen Sink", type: "addTag" },
						{ tag: "old", type: "removeTag" },
						{ type: "markRead" },
						{ type: "markUnread" },
						{ type: "flag" },
						{ mailbox: "Backup", type: "copy" },
						{ mailbox: "Sink", type: "move" },
						{ to: "oncall@example.com", type: "forward" },
						{ type: "stopProcessing" },
					],
					conditions: {
						bodyContains: "wire transfer",
						from: "acme.example",
						hasAttachment: true,
						subject: "contract",
						to: "legal@",
					},
					match: "any",
					name: "Kitchen sink",
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			// SieveScript/set would have rejected an invalid script — reaching an
			// active managed script with 2 rules proves the full vocabulary compiles.
			expect((await managedScript())?.isActive).toBe(true);
			const listed = (await listMailRules(deps, TOKEN)).content[0]?.text ?? "";
			expect(listed).toContain("2 mail rule(s)");

			const kitchenId = listed.match(KITCHEN_RULE_ID_RE)?.[1] as string;
			const deleted = await deleteMailRule(deps, {
				args: { ruleId: kitchenId },
				token: TOKEN,
			});
			expect(deleted.isError).toBeUndefined();
		});

		test("delete_mail_rule removes the last rule and the managed script carries none", async () => {
			const listed = (await listMailRules(deps, TOKEN)).content[0]?.text ?? "";
			const ruleId = listed.match(RULE_ID_RE)?.[1] as string;

			const result = await deleteMailRule(deps, {
				args: { ruleId },
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain(ruleId);

			expect((await listMailRules(deps, TOKEN)).content[0]?.text).toContain(
				"No mail rules configured"
			);
			const script = await managedScript();
			const content = await scriptContent(script?.blobId ?? "");
			expect(content).not.toContain("# langmail-rule ");
		});
	}
);
