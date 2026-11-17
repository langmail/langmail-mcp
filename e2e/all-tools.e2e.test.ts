// Every tool, once, through the built server, against a real Stalwart.
//
// The other suites go deep on one tool group each. This one goes wide: it
// starts `dist/index.js` the way a user's agent does and calls every tool the
// server lists with a realistic input, as one story an assistant could be
// asked to work through: read the mail, file it, set up a rule, plan a
// meeting, keep the address book, write and send. Each call must succeed and
// say one thing that shows it did its work.
//
// The story runs twice, in full, with two fresh accounts each time: over
// stdio and over Streamable HTTP. At the end of a run the set of tools called
// must equal the set `tools/list` returned, so a tool added later without a
// call here fails this suite.
//
// Mail is sent only between the two accounts of a run, both on the test
// Stalwart. unsubscribe_from_list runs with its opt-in off, as shipped: it
// must hand the link back and send nothing.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mailboxCreate } from "../src/jmap/index.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import {
	attachmentsOf,
	awaitSubject,
	bodyOf,
	DRAFT_ID_RE,
} from "./support/compose.ts";
import { live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	mailboxId,
	messageSource,
	openMailSession,
} from "./support/mail.ts";
import { startHttpServer, startStdioServer } from "./support/server.ts";
import { listedMessages, toolText } from "./support/tool-output.ts";
import { pollUntil } from "./support/wait.ts";

const STORY_TIMEOUT_MS = 180_000;
// Stalwart indexes and delivers after a request has returned, and other
// suites load the same server.
const SETTLE_MS = 45_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const BLOB_ID_RE = /blobId: (\S+)/u;
const URL_RE = /https?:\/\/[^\s'"]+/u;
const RULE_ID_RE = /\b(rule-[0-9a-f]{8})\b/u;
const UID_RE = /uid: (\S+)/u;
const CALENDAR_URL_RE = /url: (\S+)/u;
const CONTACT_ID_RE = /contact_id: (\S+)/u;

const INVOICE_PDF = new TextEncoder().encode(
	"%PDF-1.4\n% an invoice, as far as this suite is concerned\n%%EOF\n"
);
const AGENDA_TEXT = new TextEncoder().encode("1. Budget\n2. Dates\n");

interface Started {
	client: Client;
	stop: () => Promise<unknown>;
}

interface Transport {
	name: string;
	start: (account: TestAccount) => Promise<Started>;
}

const TRANSPORTS: Transport[] = [
	{ name: "stdio", start: startStdioServer },
	{ name: "HTTP", start: startHttpServer },
];

const first = (text: string, pattern: RegExp, what: string): string => {
	const found = pattern.exec(text)?.[1] ?? pattern.exec(text)?.[0];
	if (!found) {
		throw new Error(`no ${what} in:\n${text}`);
	}
	return found;
};

// A wall-clock date-time with seconds, as the calendar tools take it.
const wallClock = (date: Date): string => date.toISOString().slice(0, 19);
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

live("every tool, once, through the built server", () => {
	afterAll(async () => {
		await destroyCreatedAccounts();
	});

	describe.each(TRANSPORTS)("over $name", ({ name: transport, start }) => {
		const run = `${transport.toLowerCase()}${Date.now()}`;
		// The words the story searches for; unique to this run.
		const phrase = `quarterly-planning-${run}`;

		let me: TestAccount;
		let peer: TestAccount;
		let mine: MailSession;
		let theirs: MailSession;
		let server: Started;
		// The peer's own agent: it sends the invitation the user answers.
		let peerServer: Started;
		const called = new Set<string>();

		// Calls a tool as the user's agent and returns the text of the answer.
		// A tool that reports an error fails the story here, with what it said.
		const call = async (
			name: string,
			args: Record<string, unknown> = {},
			client: Client = server.client
		): Promise<string> => {
			if (client === server.client) {
				called.add(name);
			}
			const result = await client.callTool({ arguments: args, name });
			const text = toolText(result);
			expect(
				result.isError,
				`${name} answered with an error:\n${text}`
			).not.toBe(true);
			return text;
		};

		// Repeats a read through the search index until it shows what an earlier
		// write put there.
		const eventually = (
			name: string,
			args: Record<string, unknown>,
			settled: (text: string) => boolean,
			waitingFor: string
		): Promise<string> =>
			pollUntil(() => call(name, args), settled, {
				intervalMs: 300,
				timeoutMs: SETTLE_MS,
				waitingFor,
			});

		// Ids the story hands from one step to the next, as an agent would.
		const ids = {
			invoice: "",
			invoiceBlob: "",
			kickoff: "",
			newsletter: "",
			promo: "",
			receipt: "",
			uploadedBlob: "",
		};

		beforeAll(async () => {
			me = await createAccount({
				localPart: uniqueLocalPart(`all-tools-${transport.toLowerCase()}`),
			});
			peer = await createAccount({
				localPart: uniqueLocalPart(`all-tools-peer-${transport.toLowerCase()}`),
			});
			mine = await openMailSession(me.authorization);
			theirs = await openMailSession(peer.authorization);

			const now = Date.now();
			const kickoffId = `<kickoff-${run}@e2e.example.com>`;
			// A conversation with the peer, an invoice with a PDF, a newsletter
			// that offers one-click unsubscribe, and two messages to file away.
			await importEmail(mine, {
				raw: messageSource({
					body: `Shall we start the ${phrase} next week?`,
					date: new Date(now - 2 * DAY_MS),
					from: `Peer <${peer.address}>`,
					messageId: kickoffId,
					subject: `Kickoff ${run}`,
					to: me.address,
				}),
				receivedAt: new Date(now - 2 * DAY_MS),
			});
			await importEmail(mine, {
				raw: messageSource({
					body: `One more thing on the ${phrase}: bring the numbers.`,
					date: new Date(now - DAY_MS),
					from: `Peer <${peer.address}>`,
					messageId: `<kickoff-2-${run}@e2e.example.com>`,
					references: [kickoffId],
					subject: `Re: Kickoff ${run}`,
					to: me.address,
				}),
				receivedAt: new Date(now - DAY_MS),
			});
			await importEmail(mine, {
				raw: [
					"From: Billing <billing@shop.example.com>",
					`To: ${me.address}`,
					`Subject: Invoice ${run}`,
					`Message-ID: <invoice-${run}@e2e.example.com>`,
					`Date: ${new Date(now - 3 * HOUR_MS).toUTCString()}`,
					"MIME-Version: 1.0",
					'Content-Type: multipart/mixed; boundary="b1"',
					"",
					"--b1",
					"Content-Type: text/plain; charset=utf-8",
					"",
					`Your invoice ${run} is attached.`,
					"--b1",
					'Content-Type: application/pdf; name="invoice.pdf"',
					'Content-Disposition: attachment; filename="invoice.pdf"',
					"Content-Transfer-Encoding: base64",
					"",
					Buffer.from(INVOICE_PDF).toString("base64"),
					"--b1--",
					"",
				].join("\r\n"),
				receivedAt: new Date(now - 3 * HOUR_MS),
			});
			await importEmail(mine, {
				raw: [
					`Delivered-To: ${me.address}`,
					"From: News <news@news.example.com>",
					`To: ${me.address}`,
					`Subject: Weekly news ${run}`,
					`Message-ID: <news-${run}@e2e.example.com>`,
					`Date: ${new Date(now - 2 * HOUR_MS).toUTCString()}`,
					`List-Unsubscribe: <https://news.example.com/unsubscribe?u=${run}>`,
					"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
					"Content-Type: text/plain; charset=utf-8",
					"",
					`This week in news ${run}.`,
				].join("\r\n"),
				receivedAt: new Date(now - 2 * HOUR_MS),
			});
			await importEmail(mine, {
				body: `Thanks for your order ${run}.`,
				from: "Shop <orders@shop.example.com>",
				subject: `Receipt ${run}`,
			});
			await importEmail(mine, {
				body: `Everything must go ${run}.`,
				from: "Deals <deals@shop.example.com>",
				subject: `Sale ${run}`,
			});

			// A new Stalwart account has no Archive mailbox, and archive_emails
			// never creates one: the user's mail client does.
			await mailboxCreate({
				accountId: mine.accountId,
				apiUrl: mine.apiUrl,
				authorization: mine.authorization,
				name: "Archive",
				role: "archive",
			});

			server = await start(me);
			peerServer = await startStdioServer(peer);
		});

		afterAll(async () => {
			await server?.stop();
			await peerServer?.stop();
		});

		// Finds one seeded message by its subject, the way the agent would.
		const find = async (subject: string): Promise<string> => {
			const text = await eventually(
				"search_emails",
				{ query: `"${subject}"` },
				(found) => found.includes(subject),
				`search_emails to find "${subject}"`
			);
			const hit = listedMessages(text).find(
				(message) => message.subject === subject
			);
			if (!hit) {
				throw new Error(`"${subject}" is not listed in:\n${text}`);
			}
			return hit.id;
		};

		test(
			"reading mail: search, get, thread, preview",
			async () => {
				const hits = await eventually(
					"search_emails",
					{ query: phrase },
					(text) => listedMessages(text).length === 2,
					`search_emails to find both messages with ${phrase}`
				);
				const kickoff = listedMessages(hits).find(
					(message) => message.subject === `Kickoff ${run}`
				);
				expect(kickoff?.from).toContain(peer.address);
				ids.kickoff = kickoff?.id ?? "";

				const thread = listedMessages(
					await call("get_thread", { id: ids.kickoff })
				);
				expect(thread.map((message) => message.subject)).toEqual([
					`Kickoff ${run}`,
					`Re: Kickoff ${run}`,
				]);

				ids.invoice = await find(`Invoice ${run}`);
				const invoice = await call("get_email", { id: ids.invoice });
				expect(invoice).toContain(`Your invoice ${run} is attached.`);
				expect(invoice).toContain("invoice.pdf");
				ids.invoiceBlob = first(invoice, BLOB_ID_RE, "attachment blobId");

				called.add("preview_email");
				const preview = await server.client.callTool({
					arguments: { id: ids.invoice },
					name: "preview_email",
				});
				expect(preview.isError, toolText(preview)).not.toBe(true);
				expect(preview.structuredContent).toMatchObject({
					attachmentCount: 1,
					subject: `Invoice ${run}`,
				});

				// The page the client shows that preview in.
				const viewer = await server.client.readResource({
					uri: "ui://langmail/email-viewer",
				});
				const [page] = viewer.contents as {
					mimeType?: string;
					text?: string;
				}[];
				expect(page?.mimeType).toBe("text/html;profile=mcp-app");
				expect(page?.text).toContain("<html");
			},
			STORY_TIMEOUT_MS
		);

		test(
			"files: download an attachment and a message, upload a file",
			async () => {
				const attachment = await call("download_attachment", {
					blobId: ids.invoiceBlob,
					emailId: ids.invoice,
				});
				const downloaded = await fetch(first(attachment, URL_RE, "URL"));
				expect(downloaded.status).toBe(200);
				expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
					INVOICE_PDF
				);

				const eml = await call("download_email", { emailId: ids.invoice });
				const source = await fetch(first(eml, URL_RE, "URL"));
				expect(source.status).toBe(200);
				expect(await source.text()).toContain(`Subject: Invoice ${run}`);

				const upload = await call("upload_attachments", {
					files: [{ filename: "agenda.txt", mimeType: "text/plain" }],
				});
				const put = await fetch(first(upload, URL_RE, "upload URL"), {
					body: AGENDA_TEXT,
					method: "PUT",
				});
				expect(put.status).toBe(200);
				const stored = (await put.json()) as { blobId?: string };
				expect(stored.blobId).toBeTruthy();
				ids.uploadedBlob = stored.blobId ?? "";
			},
			STORY_TIMEOUT_MS
		);

		test(
			"filing mail: mark, archive, move, trash, and an unsubscribe that sends nothing",
			async () => {
				const marked = await call("mark_emails", {
					ids: [ids.kickoff],
					read: true,
					starred: true,
				});
				expect(marked).toContain("Marked 1 message(s) as read, starred");
				const starred = await eventually(
					"search_emails",
					{ starred: true },
					(text) => text.includes(`Kickoff ${run}`),
					"the starred message to show in search_emails"
				);
				expect(
					listedMessages(starred).map((message) => message.subject)
				).toEqual([`Kickoff ${run}`]);

				ids.receipt = await find(`Receipt ${run}`);
				await call("archive_emails", { ids: [ids.receipt] });
				const archived = await eventually(
					"search_emails",
					{ mailbox: "Archive", query: `"Receipt ${run}"` },
					(text) => text.includes(`Receipt ${run}`),
					"the archived message to show in Archive"
				);
				expect(archived).toContain(ids.receipt);

				await call("move_emails", { ids: [ids.receipt], mailbox: "Inbox" });
				await eventually(
					"search_emails",
					{ mailbox: "Inbox", query: `"Receipt ${run}"` },
					(text) => text.includes(`Receipt ${run}`),
					"the moved message to be back in the Inbox"
				);

				ids.promo = await find(`Sale ${run}`);
				await call("trash_emails", { ids: [ids.promo] });
				await eventually(
					"search_emails",
					{ mailbox: "Trash", query: `"Sale ${run}"` },
					(text) => text.includes(`Sale ${run}`),
					"the trashed message to show in Trash"
				);

				ids.newsletter = await find(`Weekly news ${run}`);
				const unsubscribe = await call("unsubscribe_from_list", {
					id: ids.newsletter,
				});
				expect(unsubscribe).toContain("LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST");
				expect(unsubscribe).toContain("Nothing was sent");
				expect(unsubscribe).toContain(
					`https://news.example.com/unsubscribe?u=${run}`
				);
			},
			STORY_TIMEOUT_MS
		);

		test(
			"mail rules: preview, create, list, update, delete",
			async () => {
				const rule = {
					actions: [{ tag: "News", type: "addTag" }],
					conditions: { from: "news@news.example.com" },
					name: `News ${run}`,
				};
				const preview = await eventually(
					"preview_mail_rule",
					rule,
					(text) => text.includes("1 existing Inbox message(s) match"),
					"preview_mail_rule to match the newsletter"
				);
				expect(preview).toContain("Nothing was created or modified");

				const created = await call("create_mail_rule", rule);
				const ruleId = first(created, RULE_ID_RE, "ruleId");

				expect(await call("list_mail_rules")).toContain(`News ${run}`);

				await call("update_mail_rule", {
					name: `Newsletters ${run}`,
					ruleId,
				});
				expect(await call("list_mail_rules")).toContain(`Newsletters ${run}`);

				await call("delete_mail_rule", { ruleId });
				expect(await call("list_mail_rules")).not.toContain(ruleId);
			},
			STORY_TIMEOUT_MS
		);

		test(
			"calendar: calendars, an event with a guest, an invitation answered",
			async () => {
				const calendars = await call("list_calendars");
				first(calendars, CALENDAR_URL_RE, "calendar URL");

				const createdCalendar = await call("create_calendar", {
					color: "#3366CC",
					name: `Trips ${run}`,
				});
				expect(createdCalendar).toContain(`Trips ${run}`);
				expect(await call("list_calendars")).toContain(`Trips ${run}`);

				await call("update_calendar", {
					calendar: `Trips ${run}`,
					name: `Travel ${run}`,
				});
				const renamed = await call("list_calendars");
				expect(renamed).toContain(`Travel ${run}`);
				expect(renamed).not.toContain(`Trips ${run}`);

				const startsAt = new Date(Date.now() + 2 * DAY_MS);
				startsAt.setUTCHours(9, 0, 0, 0);
				const window = {
					end: new Date(startsAt.getTime() + DAY_MS).toISOString(),
					start: new Date(startsAt.getTime() - DAY_MS).toISOString(),
				};

				// A meeting with the peer as a guest.
				const meeting = await call("create_calendar_event", {
					attendees: [peer.address],
					end: wallClock(new Date(startsAt.getTime() + HOUR_MS)),
					start: wallClock(startsAt),
					timeZone: "UTC",
					title: `Planning ${run}`,
				});
				const meetingUid = first(meeting, UID_RE, "event uid");
				// Inviting someone puts them in the address book.
				const guest = await eventually(
					"search_contacts",
					{ query: peer.localPart },
					(text) => text.includes(peer.address),
					"the invited guest to show in search_contacts"
				);
				expect(guest).toContain(peer.address);

				const listed = await call("list_calendar_events", window);
				expect(listed).toContain(`Planning ${run}`);
				expect(listed).toContain(meetingUid);

				await call("update_calendar_event", {
					location: "Room 2",
					uid: meetingUid,
				});
				expect(await call("list_calendar_events", window)).toContain("Room 2");

				// A private entry, moved onto the new calendar.
				const trip = await call("create_calendar_event", {
					end: wallClock(new Date(startsAt.getTime() + 5 * HOUR_MS)),
					start: wallClock(new Date(startsAt.getTime() + 3 * HOUR_MS)),
					timeZone: "UTC",
					title: `Train ${run}`,
				});
				const tripUid = first(trip, UID_RE, "event uid");
				const moved = await call("move_calendar_events", {
					calendar: `Travel ${run}`,
					uids: [tripUid],
				});
				expect(moved).toContain(`Travel ${run}`);

				// The peer invites the user; the user accepts.
				const invitation = await call(
					"create_calendar_event",
					{
						attendees: [me.address],
						end: wallClock(new Date(startsAt.getTime() + 8 * HOUR_MS)),
						start: wallClock(new Date(startsAt.getTime() + 7 * HOUR_MS)),
						timeZone: "UTC",
						title: `Review ${run}`,
					},
					peerServer.client
				);
				const invitationUid = first(invitation, UID_RE, "event uid");
				await eventually(
					"list_calendar_events",
					window,
					(text) => text.includes(invitationUid),
					"the peer's invitation to arrive on the user's calendar"
				);
				const answered = await call("respond_to_event", {
					response: "accept",
					uid: invitationUid,
				});
				expect(answered.toLowerCase()).toContain("accept");

				await call("delete_calendar_event", { uid: meetingUid });
				expect(await call("list_calendar_events", window)).not.toContain(
					meetingUid
				);
			},
			STORY_TIMEOUT_MS
		);

		test(
			"contacts: create, search, update, merge, birthdays, delete",
			async () => {
				const birthday = isoDay(new Date(Date.now() + 3 * DAY_MS));
				const created = await call("create_contact", {
					birthday,
					emails: [{ address: `robin-${run}@partner.example.com` }],
					name: `Robin Example ${run}`,
					roles: ["lawyer"],
				});
				const contactId = first(created, CONTACT_ID_RE, "contact id");

				const found = await eventually(
					"search_contacts",
					{ query: `Robin Example ${run}` },
					(text) => text.includes(`robin-${run}@partner.example.com`),
					"the new contact to show in search_contacts"
				);
				expect(found).toContain(`robin-${run}@partner.example.com`);

				const updated = await call("update_contact", {
					contactId,
					organization: `Example Law ${run}`,
				});
				expect(updated).toContain(`Example Law ${run}`);

				const duplicate = await call("create_contact", {
					emails: [{ address: `r.example-${run}@partner.example.com` }],
					name: `R. Example ${run}`,
				});
				const duplicateId = first(duplicate, CONTACT_ID_RE, "contact id");
				const merged = await call("merge_contacts", {
					contactId,
					mergeContactIds: [duplicateId],
				});
				expect(merged).toContain(`r.example-${run}@partner.example.com`);
				expect(merged).toContain(`robin-${run}@partner.example.com`);

				const birthdays = await call("list_upcoming_birthdays", { days: 14 });
				expect(birthdays).toContain(`Robin Example ${run}`);

				await call("delete_contact", { contactId });
				await eventually(
					"search_contacts",
					{ query: `Robin Example ${run}` },
					(text) => text.startsWith("No contact matched"),
					"the deleted contact to leave search_contacts"
				);
			},
			STORY_TIMEOUT_MS
		);

		test(
			"writing and sending: drafts, a reply, a forward",
			async () => {
				const peerInbox = await mailboxId(theirs, "inbox");

				const staged = await call("create_draft", {
					attachments: [
						{
							blobId: ids.uploadedBlob,
							filename: "agenda.txt",
							mimeType: "text/plain",
						},
					],
					subject: `Agenda ${run}`,
					text: "First version.",
					to: [peer.address],
				});
				const draftId = first(staged, DRAFT_ID_RE, "draftId");

				expect(await call("get_draft", { draftId })).toContain(
					"First version."
				);
				expect(await call("list_drafts")).toContain(`Agenda ${run}`);

				await call("update_draft", {
					draftId,
					text: `The agenda for the ${phrase} is attached.`,
				});
				expect(await call("get_draft", { draftId })).toContain(
					`The agenda for the ${phrase} is attached.`
				);

				await call("send_draft", { draftId });
				const [agenda] = await awaitSubject(theirs, peerInbox, `Agenda ${run}`);
				expect(bodyOf(agenda ?? null)).toContain(
					`The agenda for the ${phrase} is attached.`
				);
				const [file] = await attachmentsOf(theirs, agenda?.id ?? "");
				expect(file?.name).toBe("agenda.txt");
				expect(file?.bytes).toEqual(AGENDA_TEXT);

				// A draft the user decides against.
				const scrapped = await call("create_draft", {
					subject: `Never mind ${run}`,
					text: "On second thought.",
					to: [peer.address],
				});
				const scrappedId = first(scrapped, DRAFT_ID_RE, "draftId");
				await call("delete_draft", { draftId: scrappedId });
				expect(await call("list_drafts")).not.toContain(`Never mind ${run}`);

				await call("reply_to_message", {
					messageId: ids.kickoff,
					text: `Next week works for me ${run}.`,
				});
				const [reply] = await awaitSubject(
					theirs,
					peerInbox,
					`Re: Kickoff ${run}`
				);
				expect(bodyOf(reply ?? null)).toContain(
					`Next week works for me ${run}.`
				);

				await call("forward_message", {
					messageId: ids.invoice,
					text: "For your records.",
					to: [peer.address],
				});
				const [forward] = await awaitSubject(
					theirs,
					peerInbox,
					`Fwd: Invoice ${run}`
				);
				const [pdf] = await attachmentsOf(theirs, forward?.id ?? "");
				expect(pdf?.name).toBe("invoice.pdf");
				expect(pdf?.bytes).toEqual(INVOICE_PDF);
			},
			STORY_TIMEOUT_MS
		);

		test("the story called every tool the server lists", async () => {
			const { tools } = await server.client.listTools();
			expect([...called].sort()).toEqual(tools.map((tool) => tool.name).sort());
		});
	});
});
