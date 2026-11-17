// What this server is for, as acceptance tests against a REAL Stalwart and
// the BUILT server (`node dist/index.js`), driven by a real MCP client.
//
// Someone runs their own Stalwart. Their agent runs on the same computer
// (stdio) or on a server they own (Streamable HTTP with a bearer token). They
// want an email from years ago that they could not find themselves: they
// remember a few words from it, not its subject, and the mailbox is full of
// mail from the same sender about the same flat. The agent finds it by the
// phrase, reads it, and reads the conversation it belongs to.
//
// And nobody else gets at that mail: not a caller without the HTTP token, not
// a server holding a wrong Stalwart password, not another account on the same
// Stalwart.
//
// Every id the agent uses comes out of a tool result, the way an agent gets
// it. The suite's own JMAP access only fills the mailbox.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	createAccount,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import { live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	messageSource,
	openMailSession,
} from "./support/mail.ts";
import {
	canListListeningTcpPorts,
	type HttpServer,
	listeningTcpPorts,
	listeningTcpSockets,
	type RawStdioServer,
	type ServerOptions,
	startHttpServer,
	startRawStdioServer,
	startStdioServer,
} from "./support/server.ts";
import {
	type ListedMessage,
	listedMessages,
	toolText,
} from "./support/tool-output.ts";
import { pollUntil } from "./support/wait.ts";

// --- a message with a file ---------------------------------------------------

const ATTACHMENT_TEXT = "Meter reading 4B: 10482 kWh\n";
const ATTACHMENT_BLOB_RE = /reading\.txt — text\/plain, .* — blobId: (\S+)$/mu;
const LINK_RE = /^(http:\/\/\S+\/attachments\/[\w-]+)$/mu;

const withAttachment = (to: string): string =>
	[
		"From: Harbour Lettings <lettings@example.com>",
		`To: ${to}`,
		"Subject: Meter reading",
		`Message-ID: <meter-${Date.now()}@mail.example.com>`,
		"Date: Tue, 30 Jun 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="mixed-b"',
		"",
		"--mixed-b",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"The reading is attached.",
		"--mixed-b",
		'Content-Type: text/plain; name="reading.txt"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="reading.txt"',
		"",
		Buffer.from(ATTACHMENT_TEXT).toString("base64"),
		"--mixed-b--",
		"",
	].join("\r\n");

// --- the mailbox ------------------------------------------------------------

// What the user remembers. It stands in the body of one message from 2019
// and nowhere else: in no subject, and in no other message in this order.
const PHRASE = "Northgate Tenancy Trust";
const PHRASE_WORD_RE = /\b(?:northgate|tenancy|trust)\b/iu;
const CERTIFICATE = "NT-88213-B";

const LETTINGS = "Maren Holt <maren.holt@example.com>";
const SUBJECT = "Flat 4B paperwork";

interface Seed {
	body: string;
	from: string;
	/** Mailbox role. Default: inbox. */
	mailbox?: "sent";
	/** Position in the conversation, 1-based. Unset: not part of it. */
	position?: number;
	receivedAt: string;
	subject: string;
}

// The conversation: four messages over two days in March 2019, the second
// one the user's own reply in Sent, the third one the message being looked
// for. Its subject says nothing about a deposit, and the phrase comes late
// enough in the body that a listing's snippet does not show it.
const CONVERSATION: Seed[] = [
	{
		body: "Hello,\r\n\r\nthe signed agreement for Flat 4B arrived today. Could you also send a copy of your ID and the standing order form?\r\n\r\nMaren",
		from: LETTINGS,
		position: 1,
		receivedAt: "2019-03-04T09:12:00Z",
		subject: SUBJECT,
	},
	{
		body: "Hello Maren,\r\n\r\nboth are attached. One question: who looks after the deposit while I live there?\r\n\r\nThanks",
		from: "", // The account's own address; filled in when seeding.
		mailbox: "sent",
		position: 2,
		receivedAt: "2019-03-04T18:40:00Z",
		subject: `Re: ${SUBJECT}`,
	},
	{
		body: [
			"Hello,",
			"",
			"thank you, everything has arrived and the file for Flat 4B is complete. The standing order starts on the first of April, and the inventory follows by post next week. Please check it room by room and send it back signed within seven days.",
			"",
			`About your question: your deposit of 1,450 is protected with ${PHRASE}, certificate ${CERTIFICATE}. Keep this message. You will need the certificate number when you move out.`,
			"",
			"Maren",
		].join("\r\n"),
		from: LETTINGS,
		position: 3,
		receivedAt: "2019-03-05T08:05:00Z",
		subject: `Re: ${SUBJECT}`,
	},
	{
		body: "One more thing: the handover is on Friday at ten. Please bring the receipt for the first month.\r\n\r\nMaren",
		from: LETTINGS,
		position: 4,
		receivedAt: "2019-03-05T16:30:00Z",
		subject: `Re: ${SUBJECT}`,
	},
];

// Mail that looks like what is being looked for, and is not it: the same
// sender, the same flat, the same subject even, and bodies holding one, two
// or all three words of the phrase, only never next to each other in order.
const NEAR_MISSES: Seed[] = [
	{
		// The very subject of the conversation, two years on, outside it.
		body: "The renewal paperwork for Flat 4B is ready to sign. Nothing about the tenancy changes apart from the rent.",
		from: LETTINGS,
		receivedAt: "2021-02-11T10:00:00Z",
		subject: SUBJECT,
	},
	{
		// All three words, apart and out of order.
		body: "Your deposit stays where it is. Trust me, nothing about the tenancy changes. The Northgate office will write to you separately.",
		from: LETTINGS,
		receivedAt: "2023-06-19T14:22:00Z",
		subject: "Flat 4B deposit",
	},
	{
		// All three words next to each other, in another order.
		body: "We are now part of the Tenancy Trust Northgate group. Your contact stays the same.",
		from: LETTINGS,
		receivedAt: "2024-01-08T09:00:00Z",
		subject: "Holt Lettings news",
	},
	{
		// The first two words in order, the third elsewhere.
		body: "The Northgate tenancy office has moved to Mill Lane. You can trust the old phone number until May.",
		from: "Northgate Office <office@example.com>",
		receivedAt: "2022-04-02T11:45:00Z",
		subject: "We have moved",
	},
	{
		// The last two words in order, the first missing.
		body: "A tenancy trust is one of several ways to protect a deposit. This leaflet explains the others.",
		from: "Renters Advice <advice@example.com>",
		receivedAt: "2018-11-20T08:30:00Z",
		subject: "Know your rights",
	},
	{
		body: "The pool at Northgate is closed for repairs until the end of the month.",
		from: "Northgate Leisure <leisure@example.com>",
		receivedAt: "2019-03-05T08:10:00Z",
		subject: "Pool closed",
	},
	{
		body: "Your membership of the Coastal Trust renews next month. No action is needed.",
		from: "Coastal Trust <members@example.com>",
		receivedAt: "2020-09-01T07:00:00Z",
		subject: "Membership renewal",
	},
	{
		body: "The inventory for Flat 4B is attached. Please check it and send it back signed. It forms part of the tenancy agreement.",
		from: LETTINGS,
		receivedAt: "2019-03-12T12:00:00Z",
		subject: "Flat 4B inventory",
	},
	{
		body: "I trust the engineer found the fault. Let me know if the boiler acts up again.",
		from: LETTINGS,
		receivedAt: "2019-11-28T17:05:00Z",
		subject: "Re: Flat 4B boiler",
	},
	{
		body: "Bus 14 no longer stops at Northgate on Sundays.",
		from: "City Transit <transit@example.com>",
		receivedAt: "2025-05-04T06:00:00Z",
		subject: "Timetable change",
	},
];

// The rest of a mailbox: none of the words at all.
const OTHER_MAIL: Seed[] = [
	["Flat 4B rent receipt March", LETTINGS, "2019-03-29T09:00:00Z"],
	["Flat 4B rent receipt April", LETTINGS, "2019-04-29T09:00:00Z"],
	["Flat 4B window repair", LETTINGS, "2020-07-14T13:10:00Z"],
	["Flat 4B stairwell cleaning", LETTINGS, "2022-10-03T08:00:00Z"],
	["Flat 4B meter reading", LETTINGS, "2024-12-30T10:30:00Z"],
	["Flat 4B paperwork for the bike store", LETTINGS, "2019-03-06T15:00:00Z"],
	[
		"Your order has shipped",
		"Shop <orders@example.com>",
		"2019-03-05T07:55:00Z",
	],
	["Invoice 2019-118", "Billing <billing@example.com>", "2019-03-04T12:00:00Z"],
	["Dinner on Saturday?", "Jonas <jonas@example.com>", "2019-03-03T19:20:00Z"],
	["Library reminder", "Library <library@example.com>", "2018-06-15T09:00:00Z"],
	["Your ticket to Lisbon", "Rail <rail@example.com>", "2021-08-09T05:40:00Z"],
	[
		"Password changed",
		"Accounts <accounts@example.com>",
		"2023-02-02T22:15:00Z",
	],
	["Weekly digest", "Digest <digest@example.com>", "2025-01-06T06:00:00Z"],
	["Weekly digest", "Digest <digest@example.com>", "2025-01-13T06:00:00Z"],
	[
		"Electricity statement",
		"Power <power@example.com>",
		"2026-03-01T04:00:00Z",
	],
	["Welcome to the choir", "Choir <choir@example.com>", "2026-09-17T18:00:00Z"],
].map(([subject, from, receivedAt]) => ({
	body: `This is the message about: ${subject}. Nothing else to report.`,
	from: from as string,
	receivedAt: receivedAt as string,
	subject: subject as string,
}));

// Filed in this order, so the conversation's order below is the thread's and
// not the order of arrival, and the wanted message is neither first nor last.
const MAILBOX: Seed[] = [
	...NEAR_MISSES.slice(0, 4),
	CONVERSATION[3] as Seed,
	...OTHER_MAIL.slice(0, 8),
	CONVERSATION[1] as Seed,
	...NEAR_MISSES.slice(4),
	CONVERSATION[2] as Seed,
	...OTHER_MAIL.slice(8),
	CONVERSATION[0] as Seed,
];

// How many messages hold at least one word of the phrase. A search for the
// bare words lists this many once Stalwart has indexed the whole mailbox.
const HOLDING_A_WORD = MAILBOX.filter((seed) =>
	PHRASE_WORD_RE.test(`${seed.subject} ${seed.body}`)
).length;

// What only the mailbox's owner may see. Compared without case.
const privateStrings = (account: TestAccount): string[] => [
	PHRASE,
	CERTIFICATE,
	SUBJECT,
	"Flat 4B",
	"Maren",
	account.address,
	account.localPart,
];

const seedMailbox = async (
	account: TestAccount
): Promise<{ wantedId: string }> => {
	const session: MailSession = await openMailSession(account.authorization);
	const conversationId = (position: number): string =>
		`<flat-4b-${position}.${account.localPart}@mail.example.com>`;
	let wantedId = "";
	// One at a time: Stalwart allows an account four requests at once.
	for (const seed of MAILBOX) {
		const sent = seed.mailbox === "sent";
		const date = new Date(seed.receivedAt);
		const id = await importEmail(session, {
			mailbox: seed.mailbox ?? "inbox",
			raw: messageSource({
				body: seed.body,
				date,
				from: sent ? account.address : seed.from,
				messageId: seed.position
					? conversationId(seed.position)
					: `<${date.getTime()}.${Math.random().toString(36).slice(2)}@mail.example.com>`,
				references: Array.from(
					{ length: (seed.position ?? 1) - 1 },
					(_, index) => conversationId(index + 1)
				),
				subject: seed.subject,
				to: sent ? LETTINGS : account.address,
			}),
			receivedAt: date,
		});
		if (seed.body.includes(PHRASE)) {
			wantedId = id;
		}
	}
	return { wantedId };
};

// --- the agent --------------------------------------------------------------

interface ToolAnswer {
	isError: boolean;
	text: string;
}

const callTool = async (
	client: Client,
	name: string,
	args: Record<string, unknown>
): Promise<ToolAnswer> => {
	const result = await client.callTool({ arguments: args, name });
	return { isError: result.isError === true, text: toolText(result) };
};

// Stalwart indexes for search after a write has returned, and other suites
// load the same server.
const INDEX_BUDGET_MS = 60_000;
const INDEX_POLL_MS = 500;
const SEED_TIMEOUT_MS = 180_000;
const THREAD_BUDGET_MS = 30_000;

/**
 * Waits, through the tool, until the search index holds the whole mailbox:
 * until a search for the bare words lists every message holding one. Only
 * then does "the phrase finds one message" say something about the near
 * misses.
 */
const untilMailboxIsSearchable = (client: Client): Promise<ToolAnswer> =>
	pollUntil(
		() => callTool(client, "search_emails", { limit: 100, query: PHRASE }),
		(answer) =>
			answer.text.startsWith(
				`${HOLDING_A_WORD} of ${HOLDING_A_WORD} message(s) matched:`
			),
		{
			intervalMs: INDEX_POLL_MS,
			timeoutMs: INDEX_BUDGET_MS,
			waitingFor: `search_emails to list all ${HOLDING_A_WORD} messages holding a word of the phrase`,
		}
	);

interface RunningServer {
	client: Client;
	stop: () => Promise<unknown>;
}

interface Transport {
	name: string;
	start: (
		account: TestAccount,
		options?: ServerOptions
	) => Promise<RunningServer>;
}

const TRANSPORTS: Transport[] = [
	{ name: "on the same computer (stdio)", start: startStdioServer },
	{ name: "over the network (Streamable HTTP)", start: startHttpServer },
];

// --- raw HTTP, for callers the SDK client would not let through -------------

const rpc = (method: string, params: unknown = {}): string =>
	JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });

const REFUSED_REQUESTS: [string, string][] = [
	[
		"initialize",
		rpc("initialize", {
			capabilities: {},
			clientInfo: { name: "stranger", version: "0" },
			protocolVersion: "2025-06-18",
		}),
	],
	["tools/list", rpc("tools/list")],
	[
		"a search_emails call for the phrase",
		rpc("tools/call", {
			arguments: { query: `"${PHRASE}"` },
			name: "search_emails",
		}),
	],
];

live("an agent finds an old email on the user's own Stalwart", () => {
	let owner: TestAccount;
	let neighbour: TestAccount;
	// Known from filing the message. The agent never gets it from here; the
	// tests use it to check what the agent found, and as the id a caller who
	// is not allowed in might have got hold of.
	let wantedId: string;

	beforeAll(async () => {
		owner = await createAccount({ localPart: uniqueLocalPart("agent-e2e") });
		neighbour = await createAccount({
			localPart: uniqueLocalPart("agent-e2e-neighbour"),
		});
		({ wantedId } = await seedMailbox(owner));
		// The neighbour has mail of their own, so a search of theirs that finds
		// nothing is not the search of an empty mailbox.
		await importEmail(await openMailSession(neighbour.authorization), {
			body: "The pool at Northgate is open again.",
			from: "Northgate Leisure <leisure@example.com>",
			subject: "Pool open",
		});
	}, SEED_TIMEOUT_MS);

	afterAll(destroyCreatedAccounts);

	describe.each(TRANSPORTS)("an agent $name", ({ start }) => {
		let server: RunningServer;
		// The agent's steps build on each other. Each is taken once and shared,
		// so every test below stands on its own and none repeats a search.
		let found: Promise<ListedMessage[]> | undefined;

		const call = (
			name: string,
			args: Record<string, unknown>
		): Promise<ToolAnswer> => callTool(server.client, name, args);

		const searchForThePhrase = (): Promise<ListedMessage[]> => {
			found ??= call("search_emails", { query: `"${PHRASE}"` }).then(
				(answer) => {
					expect(answer.isError).toBe(false);
					expect(answer.text.startsWith("1 of 1 message(s) matched:")).toBe(
						true
					);
					return listedMessages(answer.text);
				}
			);
			return found;
		};

		const idFromSearch = async (): Promise<string> => {
			const [hit] = await searchForThePhrase();
			if (!hit) {
				throw new Error("the search for the phrase listed no message");
			}
			return hit.id;
		};

		beforeAll(async () => {
			server = await start(owner);
			await untilMailboxIsSearchable(server.client);
		});

		afterAll(async () => {
			await server?.stop();
		});

		test("is offered the tools, and told how to search for a phrase", async () => {
			const { tools } = await server.client.listTools();
			const byName = new Map(tools.map((tool) => [tool.name, tool]));

			for (const name of ["search_emails", "get_email", "get_thread"]) {
				expect(byName.get(name)?.description).toBeTruthy();
			}
			const query = byName.get("search_emails")?.inputSchema.properties
				?.query as { description?: string } | undefined;
			expect(query?.description).toContain("Wrap a phrase in double quotes");
			expect(byName.get("get_email")?.inputSchema.required).toEqual(["id"]);
			expect(byName.get("get_thread")?.inputSchema.required).toEqual(["id"]);
		});

		test("finds the one message holding the phrase, among mail that looks like it", async () => {
			// The words alone match every near miss too.
			const words = await call("search_emails", { limit: 100, query: PHRASE });
			expect(listedMessages(words.text)).toHaveLength(HOLDING_A_WORD);
			expect(HOLDING_A_WORD).toBe(NEAR_MISSES.length + 1);

			// The phrase matches one message.
			const hits = await searchForThePhrase();
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({
				date: "2019-03-05T08:05:00Z",
				from: LETTINGS,
				id: wantedId,
				subject: `Re: ${SUBJECT}`,
			});
			// Nothing about the hit's subject would have led there.
			expect(hits[0]?.subject).not.toContain("Northgate");
		});

		test("reads the message it found, phrase and all", async () => {
			const answer = await call("get_email", { id: await idFromSearch() });

			expect(answer.isError).toBe(false);
			expect(answer.text).toContain(`Subject: Re: ${SUBJECT}`);
			expect(answer.text).toContain(`From: ${LETTINGS}`);
			expect(answer.text).toContain(`To: ${owner.address}`);
			expect(answer.text).toContain("Date: 2019-03-05T08:05:00Z");
			expect(answer.text).toContain(
				`your deposit of 1,450 is protected with ${PHRASE}, certificate ${CERTIFICATE}.`
			);
			// The whole body, first line to last.
			expect(answer.text).toContain("the file for Flat 4B is complete");
			expect(answer.text).toContain(
				"You will need the certificate number when you move out."
			);
		});

		test("reads the whole conversation in order, the user's own reply in Sent included", async () => {
			const id = await idFromSearch();
			// Stalwart threads on arrival; under load the last link can lag.
			const answer = await pollUntil(
				() => call("get_thread", { id }),
				(listing) => listing.text.startsWith("4 message(s) in thread:"),
				{
					intervalMs: INDEX_POLL_MS,
					timeoutMs: THREAD_BUDGET_MS,
					waitingFor:
						"get_thread to list the four messages of the conversation",
				}
			);
			expect(answer.isError).toBe(false);
			const thread = listedMessages(answer.text);

			expect(
				thread.map(({ date, from, subject }) => ({ date, from, subject }))
			).toEqual(
				CONVERSATION.map((seed) => ({
					date: seed.receivedAt,
					from: seed.mailbox === "sent" ? owner.address : seed.from,
					subject: seed.subject,
				}))
			);
			// The message asked about is marked, and is the third of the four.
			expect(thread.map((message) => message.requested)).toEqual([
				false,
				false,
				true,
				false,
			]);
			expect(thread[2]?.id).toBe(id);
			// Each message shows how it begins.
			expect(answer.text).toContain("the signed agreement for Flat 4B arrived");
			expect(answer.text).toContain("who looks after the deposit");
			expect(answer.text).toContain("the handover is on Friday at ten");

			// The second message is the user's own, and it is the one in Sent: the
			// agent finds the same id by looking there.
			const sent = await pollUntil(
				() =>
					call("search_emails", {
						mailbox: "Sent",
						query: '"both are attached"',
					}),
				(listing) => listing.text.startsWith("1 of 1 message(s) matched:"),
				{
					intervalMs: INDEX_POLL_MS,
					timeoutMs: INDEX_BUDGET_MS,
					waitingFor: "search_emails to find the reply in Sent",
				}
			);
			expect(listedMessages(sent.text).map((message) => message.id)).toEqual([
				thread[1]?.id,
			]);

			// Mail on the same subject from the same sender is not part of it.
			expect(answer.text).not.toContain("2021-02-11");
			expect(answer.text).not.toContain("bike store");

			// Read from its first message, it is the same conversation.
			const fromTheStart = await call("get_thread", {
				id: thread[0]?.id as string,
			});
			expect(
				listedMessages(fromTheStart.text).map((message) => message.id)
			).toEqual(thread.map((message) => message.id));
		});
	});

	describe("a caller who isn't allowed in gets nothing", () => {
		describe("over HTTP, without the server's token", () => {
			let server: HttpServer;
			let toolNames: string[];

			beforeAll(async () => {
				server = await startHttpServer(owner);
				// The mail is there and findable: what is refused below is refused
				// for the caller, not for lack of anything to find.
				await untilMailboxIsSearchable(server.client);
				const { tools } = await server.client.listTools();
				toolNames = tools.map((tool) => tool.name);
			});

			afterAll(async () => {
				await server?.stop();
			});

			test.each<[string, () => Record<string, string>]>([
				["no token", () => ({})],
				[
					"a wrong token",
					() => ({ authorization: "Bearer not-the-right-token-at-all" }),
				],
				[
					"the mailbox's app password as the token",
					() => ({ authorization: `Bearer ${owner.secret}` }),
				],
			])(
				"%s: 401, and not a word of the mail or the tools",
				async (_, headers) => {
					expect(toolNames).toContain("search_emails");
					for (const [request, body] of REFUSED_REQUESTS) {
						const res = await fetch(server.mcpUrl, {
							body,
							headers: {
								accept: "application/json, text/event-stream",
								"content-type": "application/json",
								...headers(),
							},
							method: "POST",
						});
						expect(res.status, request).toBe(401);
						const answered = (
							(await res.text()) + JSON.stringify([...res.headers])
						).toLowerCase();
						for (const secret of [...privateStrings(owner), ...toolNames]) {
							expect(answered, request).not.toContain(secret.toLowerCase());
						}
					}
				}
			);

			test("the same search with the token finds the message", async () => {
				const answer = await callTool(server.client, "search_emails", {
					query: `"${PHRASE}"`,
				});
				expect(listedMessages(answer.text).map((hit) => hit.id)).toEqual([
					wantedId,
				]);
			});
		});

		describe.each(TRANSPORTS)("from Stalwart's side, $name", ({ start }) => {
			test("a server holding a wrong Stalwart password connects, and every tool says what is wrong and returns no mail", async () => {
				const wrongPassword = "not-the-app-password";
				const server = await start(owner, {
					env: { STALWART_PASSWORD: wrongPassword },
				});
				try {
					// The handshake and the tool list do not need Stalwart.
					const { tools } = await server.client.listTools();
					expect(tools.map((tool) => tool.name)).toContain("search_emails");

					for (const [name, args] of [
						["search_emails", { query: `"${PHRASE}"` }],
						["search_emails", { limit: 100, query: PHRASE }],
						["get_email", { id: wantedId }],
						["get_thread", { id: wantedId }],
					] as const) {
						const answer = await callTool(server.client, name, args);
						expect(answer.isError, name).toBe(true);
						expect(answer.text, name).toContain(
							"rejected the credential (HTTP 401)"
						);
						expect(answer.text, name).toContain(
							"Check STALWART_USERNAME and STALWART_PASSWORD (an app password), or STALWART_TOKEN"
						);
						expect(answer.text, name).not.toContain(wrongPassword);
						const lowered = answer.text.toLowerCase();
						for (const secret of privateStrings(owner)) {
							expect(lowered, name).not.toContain(secret.toLowerCase());
						}
					}
				} finally {
					await server.stop();
				}
			});

			test("a server signed in as another account on the same Stalwart does not find the message", async () => {
				const server = await start(neighbour);
				try {
					// It works, and sees the neighbour's own mail.
					const own = await pollUntil(
						() =>
							callTool(server.client, "search_emails", {
								limit: 100,
								query: PHRASE,
							}),
						(answer) => answer.text.startsWith("1 of 1 message(s) matched:"),
						{
							intervalMs: INDEX_POLL_MS,
							timeoutMs: INDEX_BUDGET_MS,
							waitingFor:
								"the neighbour's search_emails to list their one message",
						}
					);
					expect(
						listedMessages(own.text).map((message) => message.subject)
					).toEqual(["Pool open"]);

					// The phrase finds nothing there.
					const phrase = await callTool(server.client, "search_emails", {
						query: `"${PHRASE}"`,
					});
					expect(phrase).toEqual({
						isError: false,
						text: "No messages matched.",
					});

					// Nor does knowing the message's id help: ids are per account.
					for (const name of ["get_email", "get_thread"]) {
						const answer = await callTool(server.client, name, {
							id: wantedId,
						});
						const lowered = answer.text.toLowerCase();
						for (const secret of privateStrings(owner)) {
							expect(lowered, name).not.toContain(secret.toLowerCase());
						}
					}
				} finally {
					await server.stop();
				}
			});
		});
	});

	describe("the stdio server keeps to its pipes", () => {
		let server: RawStdioServer;

		// The text of a tools/call answer read off the pipe.
		const call = async (
			name: string,
			args: Record<string, unknown>
		): Promise<ToolAnswer> => {
			const { result } = await server.request("tools/call", {
				arguments: args,
				name,
			});
			const answer = (result ?? {}) as { content?: unknown; isError?: boolean };
			return { isError: answer.isError === true, text: toolText(answer) };
		};

		beforeAll(async () => {
			// As a user's MCP client starts it: no LOG_LEVEL, nothing extra. The
			// suite reads the pipes itself here, because the SDK's client skips
			// stdout lines it cannot parse without a word.
			server = await startRawStdioServer(owner);
			await pollUntil(
				() => call("search_emails", { query: `"${PHRASE}"` }),
				(answer) => answer.text.startsWith("1 of 1 message(s) matched:"),
				{
					intervalMs: INDEX_POLL_MS,
					timeoutMs: INDEX_BUDGET_MS,
					waitingFor: "search_emails over the raw pipe to find the message",
				}
			);
		});

		afterAll(async () => {
			await server?.stop();
		});

		test("stdout carries JSON-RPC messages only, and stderr stays silent while tools succeed", async () => {
			const listed = await server.request("tools/list");
			expect(JSON.stringify(listed)).toContain('"name":"search_emails"');
			const [hit] = listedMessages(
				(await call("search_emails", { query: `"${PHRASE}"` })).text
			);
			const id = hit?.id as string;
			expect((await call("get_email", { id })).text).toContain(PHRASE);
			expect((await call("get_thread", { id })).isError).toBe(false);

			const lines = server.stdoutLines();
			// The handshake, the list, and at least the four tool calls above.
			expect(lines.length).toBeGreaterThanOrEqual(6);
			for (const line of lines) {
				expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
			}
			expect(server.stderr()).toBe("");
		});

		test("a tool's refusal is logged to stderr as one line, without the mail", async () => {
			expect(await call("get_email", { id: "zzzzzzzzzz" })).toEqual({
				isError: true,
				text: "Email not found: zzzzzzzzzz",
			});

			const log = await pollUntil(
				() => Promise.resolve(server.stderr()),
				(written) => written.includes("\n"),
				{ timeoutMs: 5000, waitingFor: "the tool's log line on stderr" }
			);
			const lines = log.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0] as string)).toMatchObject({
				outcome: "tool_error",
				tool: "get_email",
			});
			const lowered = log.toLowerCase();
			for (const secret of [...privateStrings(owner), owner.secret]) {
				expect(lowered).not.toContain(secret.toLowerCase());
			}
			// The refusal went to the caller on stdout, as JSON-RPC like the rest.
			for (const line of server.stdoutLines()) {
				expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
			}
		});

		// Read from Linux's /proc; elsewhere there is no cheap, sure way to ask.
		test.skipIf(!canListListeningTcpPorts)(
			"it listens on no TCP port until it hands out a file link, then on one loopback port; the HTTP server listens on exactly its own",
			async () => {
				// Searching, reading and listing tools have opened nothing.
				expect(listeningTcpSockets(server.pid)).toEqual([]);

				// A message with a file, and the agent's way to it.
				const emailId = await importEmail(
					await openMailSession(owner.authorization),
					{ raw: withAttachment(owner.address) }
				);
				const blobId = (await call("get_email", { id: emailId })).text.match(
					ATTACHMENT_BLOB_RE
				)?.[1];
				expect(blobId).toBeDefined();
				// Reading about the attachment still opens nothing.
				expect(listeningTcpSockets(server.pid)).toEqual([]);

				const download = await call("download_attachment", { blobId, emailId });
				expect(download.isError).toBe(false);
				const url = new URL(download.text.match(LINK_RE)?.[1] as string);
				expect(url.hostname).toBe("127.0.0.1");
				// The link's port is the only one, and only this machine reaches it.
				expect(listeningTcpSockets(server.pid)).toEqual([
					{ address: "127.0.0.1", port: Number(url.port) },
				]);
				expect(await (await fetch(url)).text()).toBe(ATTACHMENT_TEXT);
				// More links are served on the same port.
				expect(
					(await call("download_email", { emailId })).text.match(LINK_RE)?.[1]
				).toContain(`${url.origin}/attachments/`);
				expect(listeningTcpSockets(server.pid)).toEqual([
					{ address: "127.0.0.1", port: Number(url.port) },
				]);
				// The link went out on stdout as JSON-RPC, and nothing else did.
				for (const line of server.stdoutLines()) {
					expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
				}

				// The same question, asked of a server that must be listening.
				const http = await startHttpServer(owner);
				try {
					expect(listeningTcpPorts(http.pid)).toEqual([
						Number(new URL(http.baseUrl).port),
					]);
				} finally {
					await http.stop();
				}
			}
		);
	});
});
