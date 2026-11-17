// get_email and get_thread against a REAL Stalwart. Their unit tests feed
// them fake JMAP answers; this suite proves the live path: that get_email
// downloads the stored message and returns its readable body, and that
// get_thread returns every message of a conversation Stalwart threaded by
// its Message-ID / In-Reply-To / References headers, oldest first.
//
// Both tools run on their live deps and receive the account's app-password
// credential as their token, the way the server hands it over.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeJmapLive } from "../src/jmap/index.ts";
import { logger } from "../src/logger.ts";
import {
	getEmail,
	makeLiveDeps as makeGetEmailDeps,
} from "../src/tools/get-email.ts";
import {
	getThread,
	makeLiveDeps as makeGetThreadDeps,
} from "../src/tools/get-thread.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	openMailSession,
} from "./support/mail.ts";
import { pollUntil } from "./support/wait.ts";

const HOUR_MS = 3_600_000;
const HIT_ID_RE = /^ {3}id: (\S+)$/gmu;
const HIT_SUBJECT_RE = /^\d+\. (.*)$/gmu;

// Threading happens on import, but other suites load the same server.
const THREAD_BUDGET_MS = 30_000;
const THREAD_POLL_MS = 500;

live("get_email and get_thread against live Stalwart", () => {
	const run = Date.now();
	const jmapLive = makeJmapLive(ADMIN_URL);
	const getEmailDeps = makeGetEmailDeps(jmapLive);
	const getThreadDeps = makeGetThreadDeps(jmapLive);

	let session: MailSession;
	let token: string;
	let address: string;

	const messageId = (name: string): string =>
		`<${name}-${run}@read-mail.example.com>`;

	// One message of the conversation, as its complete source: the headers
	// Stalwart threads by are written out rather than left to a helper.
	const conversationMessage = (options: {
		body: string;
		from: string;
		id: string;
		receivedAt: Date;
		references?: string[];
		subject: string;
	}): string =>
		[
			`From: ${options.from}`,
			`To: ${address}`,
			`Subject: ${options.subject}`,
			`Message-ID: ${options.id}`,
			...(options.references && options.references.length > 0
				? [
						`In-Reply-To: ${options.references.at(-1)}`,
						`References: ${options.references.join(" ")}`,
					]
				: []),
			`Date: ${options.receivedAt.toUTCString()}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			options.body,
		].join("\r\n");

	beforeAll(async () => {
		const account = await createAccount({
			localPart: uniqueLocalPart("read-mail"),
		});
		({ address } = account);
		token = account.authorization;
		session = await openMailSession(token);
	});

	afterAll(destroyCreatedAccounts);

	test("get_email returns the readable body of an HTML-only message", async () => {
		const phrase = `the heron waits by the copper weir ${run}`;
		const receivedAt = new Date(run - 2 * HOUR_MS);
		const id = await importEmail(session, {
			raw: [
				"From: Mill Office <office@example.com>",
				`To: ${address}`,
				"Cc: Ledger <ledger@example.com>",
				`Subject: Water rights ${run}`,
				`Message-ID: ${messageId("html")}`,
				`Date: ${receivedAt.toUTCString()}`,
				"MIME-Version: 1.0",
				"Content-Type: text/html; charset=utf-8",
				"",
				"<html><head><style>td { border-collapse: collapse; }</style></head>",
				'<body><table style="width: 100%"><tr><td>',
				`<p>Dear miller, <b>${phrase}</b>.</p>`,
				"<p>Second paragraph about the sluice.</p>",
				"</td></tr></table></body></html>",
			].join("\r\n"),
			receivedAt,
		});

		// A warning here would mean the body came from the fallback, not from
		// the downloaded message.
		const warn = vi.spyOn(logger, "warn");
		let text: string;
		try {
			const result = await getEmail(getEmailDeps, { args: { id }, token });
			expect(result.isError).toBeFalsy();
			text = result.content[0]?.text ?? "";
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}

		expect(text).toContain(`Subject: Water rights ${run}`);
		expect(text).toContain("From: Mill Office <office@example.com>");
		expect(text).toContain(`To: ${address}`);
		expect(text).toContain("Cc: Ledger <ledger@example.com>");
		expect(text).toContain(`Date: ${receivedAt.toISOString().slice(0, 19)}`);
		expect(text).toContain(phrase);
		expect(text).toContain("Second paragraph about the sluice.");
		// Readable text, not the markup it was sent as.
		expect(text).not.toContain("<table");
		expect(text).not.toContain("<p>");
		expect(text).not.toContain("border-collapse");
	});

	test("get_email returns the body of a plain-text message as written", async () => {
		const phrase = `seven lanterns over the salt road ${run}`;
		const id = await importEmail(session, {
			body: `Hello,\r\n\r\n${phrase}.\r\n\r\nRegards`,
			from: "Caravan <caravan@example.com>",
			subject: `Salt road ${run}`,
		});

		const result = await getEmail(getEmailDeps, { args: { id }, token });

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain(`Subject: Salt road ${run}`);
		expect(text).toContain("From: Caravan <caravan@example.com>");
		expect(text).toContain(phrase);
	});

	test("get_email reports an id that names no message", async () => {
		const result = await getEmail(getEmailDeps, {
			args: { id: "zzzzzzzzzz" },
			token,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("Email not found: zzzzzzzzzz");
	});

	test("get_thread returns every message of a three-message conversation, oldest first", async () => {
		const subject = `Bridge inspection ${run}`;
		const ids = {
			first: messageId("thread-1"),
			second: messageId("thread-2"),
			third: messageId("thread-3"),
		};
		const sources = {
			first: {
				mailbox: "inbox",
				raw: conversationMessage({
					body: "Can you inspect the bridge on Monday?",
					from: "Warden <warden@example.com>",
					id: ids.first,
					receivedAt: new Date(run - 3 * HOUR_MS),
					subject,
				}),
				receivedAt: new Date(run - 3 * HOUR_MS),
			},
			second: {
				// The user's own reply, filed in Sent: a thread spans mailboxes.
				mailbox: "sent",
				raw: conversationMessage({
					body: "Monday works. I will bring the ledger.",
					from: address,
					id: ids.second,
					receivedAt: new Date(run - 2 * HOUR_MS),
					references: [ids.first],
					subject: `Re: ${subject}`,
				}),
				receivedAt: new Date(run - 2 * HOUR_MS),
			},
			third: {
				mailbox: "inbox",
				raw: conversationMessage({
					body: "Thank you, see you at the east pier.",
					from: "Warden <warden@example.com>",
					id: ids.third,
					receivedAt: new Date(run - 1 * HOUR_MS),
					references: [ids.first, ids.second],
					subject: `Re: ${subject}`,
				}),
				receivedAt: new Date(run - 1 * HOUR_MS),
			},
		};
		// Imported out of order, so the order asserted below is the thread's
		// and not the order of arrival.
		const third = await importEmail(session, sources.third);
		const first = await importEmail(session, sources.first);
		const second = await importEmail(session, sources.second);
		// Same sender, same day, another conversation: must stay out.
		const unrelated = await importEmail(session, {
			body: "The ferry timetable changes next week.",
			from: "Warden <warden@example.com>",
			receivedAt: new Date(run - 2 * HOUR_MS),
			subject: `Ferry timetable ${run}`,
		});

		const threadOf = async (id: string): Promise<string> => {
			const result = await getThread(getThreadDeps, { args: { id }, token });
			expect(result.isError).toBeFalsy();
			return result.content[0]?.text ?? "";
		};
		const text = await pollUntil(
			() => threadOf(second),
			(found) => found.startsWith("3 message(s) in thread:"),
			{
				intervalMs: THREAD_POLL_MS,
				timeoutMs: THREAD_BUDGET_MS,
				waitingFor: "the three messages to be in one thread",
			}
		);

		expect([...text.matchAll(HIT_ID_RE)].map((m) => m[1])).toEqual([
			first,
			second,
			third,
		]);
		expect([...text.matchAll(HIT_SUBJECT_RE)].map((m) => m[1])).toEqual([
			subject,
			`Re: ${subject}  ← requested`,
			`Re: ${subject}`,
		]);
		expect(text).toContain("Can you inspect the bridge on Monday?");
		expect(text).toContain("Monday works. I will bring the ledger.");
		expect(text).toContain("Thank you, see you at the east pier.");
		expect(text).not.toContain(unrelated);
		expect(text).not.toContain("Ferry timetable");

		// Asked from either end, it is the same conversation in the same order.
		for (const asked of [first, third]) {
			const again = await threadOf(asked);
			expect([...again.matchAll(HIT_ID_RE)].map((m) => m[1])).toEqual([
				first,
				second,
				third,
			]);
		}

		// A message outside the conversation is a thread of its own.
		const alone = await threadOf(unrelated);
		expect(alone.startsWith("1 message(s) in thread:")).toBe(true);
		expect([...alone.matchAll(HIT_ID_RE)].map((m) => m[1])).toEqual([
			unrelated,
		]);
	});
});
