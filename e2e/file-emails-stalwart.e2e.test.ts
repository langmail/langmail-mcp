// E2E for archive_emails / move_emails / trash_emails / mark_emails against a
// REAL Stalwart.
// The unit tests prove each tool builds the right patch against fake deps;
// this proves the patch does what we claim on the wire: archive leaves Inbox
// and lands in Archive, move replaces the folder set, trash lands in Trash,
// mark flips $seen without moving the message, and a stale id is reported
// rather than thrown.
//
// The tools receive the account's Basic app-password credential as their
// token, the complete Authorization header, exactly as the server hands it
// to them, and run on the live deps the server wires. Nothing is pinned or
// stubbed between the tools and Stalwart.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	emailGet,
	mailboxCreate,
	mailboxIdsByRoles,
	makeJmapLive,
} from "../src/jmap/index.ts";
import { archiveEmails } from "../src/tools/archive-emails.ts";
import {
	type FileEmailsDeps,
	makeLiveDeps,
} from "../src/tools/file-emails-common.ts";
import { markEmails } from "../src/tools/mark-emails.ts";
import { moveEmails } from "../src/tools/move-emails.ts";
import { trashEmails } from "../src/tools/trash-emails.ts";
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

live("filing tools against live Stalwart", () => {
	const run = Date.now();

	let session: MailSession;
	let authorization: string;
	// What the tools receive: the complete Authorization header value.
	let TOKEN: string;
	let accountId: string;
	let apiUrl: string;
	let inboxId: string;
	let archiveId: string;
	let projectsId: string;
	let trashId: string;
	let deps: FileEmailsDeps;

	const mailboxesOf = async (id: string): Promise<string[]> => {
		const [rec] = await emailGet({
			accountId,
			apiUrl,
			authorization,
			ids: [id],
		});
		return Object.keys(rec?.mailboxIds ?? {}).sort();
	};

	const isSeen = async (id: string): Promise<boolean> => {
		const [rec] = await emailGet({
			accountId,
			apiUrl,
			authorization,
			ids: [id],
		});
		return rec?.keywords?.$seen === true;
	};

	beforeAll(async () => {
		const account = await createAccount({
			localPart: uniqueLocalPart("mcp-file-e2e"),
		});
		authorization = account.authorization;
		TOKEN = account.authorization;

		session = await openMailSession(authorization);
		apiUrl = session.apiUrl;
		const jmapLive = makeJmapLive(ADMIN_URL);
		accountId = await jmapLive.resolveAccountId(authorization);
		expect(accountId).toBe(session.accountId);

		const call = { accountId, apiUrl, authorization };
		inboxId = await mailboxId(session, "inbox");

		// A stock Stalwart account has no Archive; the tool must not create one,
		// so the test does.
		archiveId = await mailboxCreate({
			...call,
			name: "Archive",
			role: "archive",
		});
		projectsId = await mailboxCreate({ ...call, name: "Projects" });
		const roles = await mailboxIdsByRoles({ ...call, roles: ["trash"] });
		if (!roles.trash) {
			throw new Error("no trash mailbox on the throwaway account");
		}
		trashId = roles.trash;

		// The live deps, wired as the server wires them.
		deps = makeLiveDeps(jmapLive);
	});

	// Throwaway principal; destroying it also drops its mail.
	afterAll(destroyCreatedAccounts);

	test("archive_emails leaves the Inbox and lands in Archive", async () => {
		const id = await importEmail(session, {
			body: "Accepted from the attendee calendar.",
			from: "Calendar Bot <calendar@example.com>",
			keywords: {},
			receivedAt: new Date(run),
			subject: "Accepted: sync",
		});
		const result = await archiveEmails(deps, {
			args: { ids: [id] },
			token: TOKEN,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toBe("Archived 1 message(s).");
		expect(await mailboxesOf(id)).toEqual([archiveId]);
	});

	test("move_emails replaces the folder set with the destination", async () => {
		const id = await importEmail(session, {
			body: "Please file this.",
			from: "Ada Example <ada@example.com>",
			keywords: {},
			receivedAt: new Date(run),
			subject: "Project kickoff",
		});
		const result = await moveEmails(deps, {
			args: { ids: [id], mailbox: "projects" },
			token: TOKEN,
		});
		expect(result.isError).toBeUndefined();
		expect(await mailboxesOf(id)).toEqual([projectsId]);
	});

	test("move_emails refuses the trash-role mailbox under its server-side name", async () => {
		const id = await importEmail(session, {
			body: "Keep me.",
			from: "Ada Example <ada@example.com>",
			keywords: {},
			receivedAt: new Date(run),
			subject: "Not a delete",
		});
		// Stock Stalwart names its trash-role mailbox "Deleted Items": not a place
		// name, so this exercises the name lookup → resolved-id refusal, not the
		// place-name short-circuit.
		const result = await moveEmails(deps, {
			args: { ids: [id], mailbox: "Deleted Items" },
			token: TOKEN,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("trash_emails");
		expect(await mailboxesOf(id)).toEqual([inboxId]);
	});

	test("trash_emails lands in Trash and a stale id is reported, not thrown", async () => {
		const id = await importEmail(session, {
			body: "Delete me.",
			from: "Noise <noise@example.com>",
			keywords: {},
			receivedAt: new Date(run),
			subject: "Spam-ish",
		});
		const result = await trashEmails(deps, {
			args: { ids: [id, "zz-does-not-exist"] },
			token: TOKEN,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Trashed 1 message(s).");
		// RFC 8620 §5.3: an unknown id in `update` is refused as `notFound`.
		expect(result.content[0]?.text).toContain("zz-does-not-exist (notFound)");
		expect(await mailboxesOf(id)).toEqual([trashId]);
	});

	test("mark_emails flips $seen both ways, idempotently, without moving the message", async () => {
		const id = await importEmail(session, {
			body: "Read me later.",
			from: "Ada Example <ada@example.com>",
			keywords: { $flagged: true },
			receivedAt: new Date(run),
			subject: "Weekly notes",
		});
		expect(await isSeen(id)).toBe(false);
		// Unread on a message that never had $seen, then each direction twice.
		for (const read of [false, true, true, false, false]) {
			const result = await markEmails(deps, {
				args: { ids: [id], read },
				token: TOKEN,
			});
			expect(result.content[0]?.text).toBe(
				`Marked 1 message(s) as ${read ? "read" : "unread"}.`
			);
			expect(await isSeen(id)).toBe(read);
		}
		const [rec] = await emailGet({
			accountId,
			apiUrl,
			authorization,
			ids: [id],
		});
		expect(rec?.keywords?.$flagged).toBe(true);
		expect(await mailboxesOf(id)).toEqual([inboxId]);
	});

	test("mark_emails sets and clears to-do and star together, leaving read state alone", async () => {
		const id = await importEmail(session, {
			body: "Please send the documents.",
			from: "Tax Office <advisor@example.com>",
			keywords: { $seen: true },
			receivedAt: new Date(run),
			subject: "Documents for the annual return",
		});
		// Stalwart sets $hasattachment / $hasnoattachment on every message
		// itself (read-only); they are not ours to assert on.
		const keywordsOf = async (): Promise<Record<string, boolean>> => {
			const [rec] = await emailGet({
				accountId,
				apiUrl,
				authorization,
				ids: [id],
			});
			return Object.fromEntries(
				Object.entries(rec?.keywords ?? {}).filter(
					([k]) => k !== "$hasattachment" && k !== "$hasnoattachment"
				)
			);
		};
		await markEmails(deps, {
			args: { ids: [id], starred: true, todo: true },
			token: TOKEN,
		});
		expect(await keywordsOf()).toEqual({
			$flagged: true,
			"$label:todo": true,
			$seen: true,
		});
		const result = await markEmails(deps, {
			args: { ids: [id], todo: false },
			token: TOKEN,
		});
		expect(result.content[0]?.text).toBe("Marked 1 message(s) as not to-do.");
		expect(await keywordsOf()).toEqual({ $flagged: true, $seen: true });
		expect(await mailboxesOf(id)).toEqual([inboxId]);
	});
});
