// E2E for unsubscribe_from_list against a REAL Stalwart.
// The unit tests prove the parser and the guards against fake records; this
// proves the JMAP read does what the parser assumes on the wire: Stalwart
// hands back `header:List-Unsubscribe` in Raw form with the folding intact,
// the Post header as text, every Delivered-To, and the Junk role.
//
// The suite never reaches a third-party host. The cases that send the
// one-click POST run with the opt-in on and a stub in place of the HTTP
// client; the last case runs the deps exactly as the server wires them with
// the opt-in off (the default) and proves no request is attempted.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import https from "node:https";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
	emailGetUnsubscribe,
	mailboxCreate,
	mailboxIdsByRoles,
	makeJmapLive,
} from "../src/jmap/index.ts";
import type { SendHop } from "../src/tools/one-click-post.ts";
import {
	makeLiveDeps,
	type UnsubscribeDeps,
	unsubscribeFromList,
} from "../src/tools/unsubscribe-from-list.ts";
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

live("unsubscribe_from_list against live Stalwart", () => {
	const run = Date.now();

	let session: MailSession;
	let address: string;
	let authorization: string;
	// What the tool receives: the complete Authorization header value.
	let TOKEN: string;
	let accountId: string;
	let apiUrl: string;
	let hops: [string, string][];
	// Live JMAP reads, wired as the server wires them; only the hop is stubbed.
	let deps: UnsubscribeDeps;

	const importNews = (headers: string[], mailbox: "inbox" | "junk") =>
		importEmail(session, {
			mailbox,
			raw: [
				`Delivered-To: ${address}`,
				"Delivered-To: jo.forwarded@old.example.com",
				"From: News <news@news.example.com>",
				`To: ${address}`,
				`Subject: Weekly news ${run}`,
				`Message-ID: <unsub-${run}-${Math.random().toString(36).slice(2)}@mcp-unsub-e2e>`,
				`Date: ${new Date(run).toUTCString()}`,
				...headers,
				"Content-Type: text/plain; charset=utf-8",
				"",
				"This week in news.",
				"Unsubscribe: https://news.example.com/footer-unsubscribe?id=7",
			].join("\r\n"),
			receivedAt: new Date(run),
		});

	beforeAll(async () => {
		const account = await createAccount({
			localPart: uniqueLocalPart("mcp-unsub-e2e"),
		});
		({ address, authorization } = account);
		TOKEN = account.authorization;

		session = await openMailSession(authorization);
		apiUrl = session.apiUrl;
		const jmapLive = makeJmapLive(ADMIN_URL);
		accountId = await jmapLive.resolveAccountId(authorization);
		expect(accountId).toBe(session.accountId);

		const call = { accountId, apiUrl, authorization };
		const roles = await mailboxIdsByRoles({
			...call,
			roles: ["inbox", "junk"],
		});
		if (!roles.inbox) {
			throw new Error("no inbox mailbox on the throwaway account");
		}
		if (!roles.junk) {
			await mailboxCreate({ ...call, name: "Junk", role: "junk" });
		}

		hops = [];
		const sendHop: SendHop = (url, method) => {
			hops.push([url, method]);
			return Promise.resolve({
				body: "Unsubscribe Request Accepted",
				location: null,
				status: 202,
			});
		};
		deps = { ...makeLiveDeps(jmapLive, { allowOneClickPost: true }), sendHop };
	});

	// Throwaway principal; destroying it also drops its mail.
	afterAll(destroyCreatedAccounts);

	const FOLDED = [
		"List-Unsubscribe: <https://news.example.com/unsubscribe?u=1&id=2>,",
		" <mailto:leave@news.example.com?subject=unsubscribe>",
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
	];

	test("reads a folded List-Unsubscribe in Raw form and every Delivered-To, newest first", async () => {
		const id = await importNews(FOLDED, "inbox");
		const rec = await emailGetUnsubscribe({
			accountId,
			apiUrl,
			authorization,
			id,
			maxBodyValueBytes: 10_000,
		});
		expect(rec?.["header:List-Unsubscribe"]).toContain("\r\n <mailto:");
		expect(rec?.["header:List-Unsubscribe-Post:asText"]).toBe(
			"List-Unsubscribe=One-Click"
		);
		expect(rec?.["header:Delivered-To:asText:all"]?.[0]).toBe(address);
	});

	test("one-click: the tool POSTs the parsed https link and reports the request as accepted", async () => {
		hops.length = 0;
		const id = await importNews(FOLDED, "inbox");
		const result = await unsubscribeFromList(deps, {
			args: { id },
			token: TOKEN,
		});
		expect(hops).toEqual([
			["https://news.example.com/unsubscribe?u=1&id=2", "POST"],
		]);
		expect(result.content[0]?.text).toContain(
			"Unsubscribe request accepted by news.example.com (HTTP 202)."
		);
		expect(result.content[0]?.text).toContain(`delivered to ${address}`);
	});

	test("mail in Junk is refused without a request", async () => {
		hops.length = 0;
		const id = await importNews(FOLDED, "junk");
		const result = await unsubscribeFromList(deps, {
			args: { id },
			token: TOKEN,
		});
		expect(result.isError).toBe(true);
		expect(hops).toEqual([]);
	});

	test("no header: the footer link from the real text body", async () => {
		const id = await importNews([], "inbox");
		const result = await unsubscribeFromList(deps, {
			args: { id },
			token: TOKEN,
		});
		expect(result.content[0]?.text).toContain(
			"no automatic way to unsubscribe"
		);
		expect(result.content[0]?.text).toContain(
			"https://news.example.com/footer-unsubscribe?id=7"
		);
	});

	test("opt-in off: a one-click sender gets no request, and the result says why and hands back the link", async () => {
		// The deps as the server wires them by default, nothing stubbed; the
		// spies only watch.
		const offDeps = makeLiveDeps(makeJmapLive(ADMIN_URL), {
			allowOneClickPost: false,
		});
		const sendHop = vi.spyOn(offDeps, "sendHop");
		const request = vi.spyOn(https, "request");
		try {
			const id = await importNews(FOLDED, "inbox");
			const result = await unsubscribeFromList(offDeps, {
				args: { id },
				token: TOKEN,
			});
			expect(sendHop).not.toHaveBeenCalled();
			expect(request).not.toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text.split("\n")).toEqual([
				"The sender offers one-click unsubscribe (RFC 8058), but this server is not set to send such requests (LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST is off), so Langmail did not call the link. Nothing was sent. To have the server send the request itself, the user sets LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST=1 in this server's configuration and restarts it.",
				"Unsubscribe link the user can open in a browser:",
				"  https://news.example.com/unsubscribe?u=1&id=2",
				"Unsubscribe address — the user can send this mail from their own account (Langmail does not send it):",
				"  To: leave@news.example.com",
				"  Subject: unsubscribe",
				`This copy was delivered to ${address}. If the sender also mails another of the user's addresses, that subscription is separate.`,
			]);
		} finally {
			request.mockRestore();
		}
	});
});
