// E2E for the search_emails filters and paging against a REAL Stalwart. The
// unit tests prove the enum maps to the right keyword strings against fake
// deps — but nothing there proves the halves meet: that
// `keywords: ["ticket"]` becomes a `hasKeyword` condition Stalwart actually
// matches, and that the hit comes back rendering its type as a tag.
//
// The regression this pins down is the one the type filter exists to fix. A
// message carrying only the coarse `$label:receipt` agent label — which
// Langmail's receipt agent writes for BOTH `receipt` and `order` mail — must
// NOT match `keywords: ["receipt"]`, while a message carrying `$type:receipt`
// must. Asserting that against a real Email/query is the only way to know the
// two namespaces are really distinct on the wire rather than just in our
// string helpers.
//
// The read/starred filters are pinned the same way: `read: false` is the only
// caller of JMAP `notKeyword`, and only a live Email/query proves Stalwart
// accepts it inside an AND node rather than answering `unsupportedFilter`.
//
// Paging is pinned last: a walk with the printed cursor must show every
// match exactly once while mail arrives or pages are marked read between
// calls, on mail where several messages share one received second — and a
// multi-term walk must list full matches first, which needs Stalwart's NOT
// filter to split partial matches off.
//
// The tool runs on its live deps and receives the account's app-password
// credential (a Basic `Authorization` value) as its token, the way the
// server hands it over.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";

import { makeJmapLive } from "../src/jmap/index.ts";
import {
	makeLiveDeps,
	type SearchEmailsDeps,
	searchEmails,
} from "../src/tools/search-emails.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import {
	importEmail as importInto,
	jmapCall,
	type MailSession,
	openMailSession,
} from "./support/mail.ts";
import { pollUntil } from "./support/wait.ts";

const DAY_MS = 86_400_000;

// Tag-line assertions, hoisted per the no-inline-regex rule.
const TAGS_RECEIPT_RE = /tags: .*receipt/u;
const TAGS_ORDER_RE = /tags: .*order/u;
const HIT_ID_RE = /^ {3}id: (\S+)$/gmu;
const CURSOR_RE = /cursor: "(v1\.[\w-]+)"/u;

// Full-text indexing lags the import, and other suites load the same server.
const INDEX_BUDGET_MS = 30_000;
const INDEX_POLL_MS = 500;

live("search_emails filters and paging against live Stalwart", () => {
	const run = Date.now();
	// The show ran "yesterday"; the booking arrived two days before that. The
	// motivating shape — the confirmation predates the event it confirms.
	const bookingReceivedAt = new Date(run - 3 * DAY_MS);
	const oldTicketReceivedAt = new Date(run - 44 * DAY_MS);

	let session: MailSession;
	let token: string;
	let deps: SearchEmailsDeps;
	const seeded: Record<string, string> = {};

	// Import one message straight into the Inbox with its keywords already set —
	// the state Langmail's classifier leaves behind after analyzing it.
	const importEmail = (opts: {
		body: string;
		from: string;
		keywords: Record<string, boolean>;
		receivedAt: Date;
		subject: string;
	}): Promise<string> => importInto(session, opts);

	const search = (args: Parameters<typeof searchEmails>[1]["args"]) =>
		searchEmails(deps, { args, token });

	const textOf = async (
		args: Parameters<typeof searchEmails>[1]["args"]
	): Promise<string> => (await search(args)).content[0]?.text ?? "";

	beforeAll(async () => {
		const account = await createAccount({
			localPart: uniqueLocalPart("search-emails"),
		});
		token = account.authorization;
		session = await openMailSession(token);
		deps = makeLiveDeps(makeJmapLive(ADMIN_URL));

		// The target: a cinema booking. Nothing in the subject says "ticket" or
		// "cinema" — that is the whole reason the type filter has to carry it.
		seeded.booking = await importEmail({
			body: "Your seats are reserved. Row 7, seats 12-13.",
			from: "Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>",
			keywords: { $seen: true, "$type:ticket": true },
			receivedAt: bookingReceivedAt,
			subject: "Booking for Signals from Saturn",
		});

		// Same type, six weeks older: proves the date window is load-bearing and
		// a bare type filter can't pass by accident.
		seeded.oldTicket = await importEmail({
			body: "Your seats are reserved. Row 2, seat 4.",
			from: "Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>",
			keywords: { $seen: true, "$type:ticket": true },
			receivedAt: oldTicketReceivedAt,
			subject: "Booking for The Long Quiet",
		});

		// An order carrying ONLY the coarse agent label — exactly what
		// Langmail's receipt agent writes for `order`-typed mail. The old enum mapped
		// `receipt` onto `$label:receipt`, so this used to come back as a receipt.
		seeded.orderWithAgentLabel = await importEmail({
			body: "Your parcel is on its way.",
			from: "Northwind Supplies <orders@northwind.example>",
			keywords: { "$label:receipt": true, $seen: true, "$type:order": true },
			receivedAt: bookingReceivedAt,
			subject: "Your order has shipped",
		});

		// A real receipt, typed as one.
		seeded.receipt = await importEmail({
			body: "Payment received, thank you.",
			from: "Hosting Co <billing@hosting.example>",
			keywords: { $seen: true, "$type:receipt": true },
			receivedAt: bookingReceivedAt,
			subject: "Invoice 4021 paid",
		});

		// Keyword bait: the word a free-text query would reach for, on mail that
		// is not a ticket.
		seeded.bait = await importEmail({
			body: "Kinotickets zum halben Preis, nur diese Woche!",
			from: "Wochenpost <newsletter@wochenpost.example>",
			keywords: { $seen: true, "$type:newsletter": true },
			receivedAt: bookingReceivedAt,
			subject: "Diese Woche im Kino",
		});

		// A to-do flag on a typed message — the orthogonal `$label:` value that
		// must keep resolving to the agent-label namespace.
		seeded.todo = await importEmail({
			body: "Please confirm by Friday.",
			from: "Acme HR <hr@acme.example>",
			keywords: { "$label:todo": true, $seen: true, "$type:direct": true },
			receivedAt: bookingReceivedAt,
			subject: "Please confirm your new contract",
		});

		// Untyped, so the type-filter totals above stay as they are: one message
		// nobody has read yet, and one read message the user starred.
		seeded.unread = await importEmail({
			body: "You have a new message waiting.",
			from: "Network <messages@network.example>",
			keywords: {},
			receivedAt: bookingReceivedAt,
			subject: "New message from a recruiter",
		});
		seeded.starred = await importEmail({
			body: "Keep this for the tax return.",
			from: "Bank <statements@bank.example>",
			keywords: { $flagged: true, $seen: true },
			receivedAt: bookingReceivedAt,
			subject: "Annual statement",
		});
	});

	afterAll(destroyCreatedAccounts);

	test("a type filter alone finds the booking Stalwart has no text match for", async () => {
		const text = await textOf({ keywords: ["ticket"], limit: 20 });

		expect(text).toContain(seeded.booking as string);
		expect(text).toContain("Booking for Signals from Saturn");
		// Only ticket-typed mail — the newsletter advertising "Kinotickets" is
		// typed `newsletter` and stays out.
		expect(text).not.toContain(seeded.bait as string);
		expect(text).not.toContain(seeded.receipt as string);
	});

	test("the type filter composes with a received-date window", async () => {
		// Widened by a booking lead time: it contains the confirmation's arrival
		// without reaching back to the six-week-old show.
		const text = await textOf({
			after: new Date(run - 21 * DAY_MS).toISOString(),
			before: new Date(run).toISOString(),
			keywords: ["ticket"],
			limit: 20,
		});

		expect(text).toContain(seeded.booking as string);
		expect(text).not.toContain(seeded.oldTicket as string);
	});

	// The conflation this feature fixes: `receipt` used to mean "whatever
	// receipt-agent labeled", which included orders.
	test("receipt returns only receipts — an order carrying $label:receipt no longer matches", async () => {
		const text = await textOf({ keywords: ["receipt"], limit: 20 });

		expect(text).toContain(seeded.receipt as string);
		expect(text).not.toContain(seeded.orderWithAgentLabel as string);
	});

	test("order returns the order the coarse label used to hide", async () => {
		const text = await textOf({ keywords: ["order"], limit: 20 });

		expect(text).toContain(seeded.orderWithAgentLabel as string);
		expect(text).not.toContain(seeded.receipt as string);
	});

	test("todo still resolves to the $label: agent flag, not a $type: keyword", async () => {
		const text = await textOf({ keywords: ["todo"], limit: 20 });

		expect(text).toContain(seeded.todo as string);
		expect(text).not.toContain(seeded.booking as string);
	});

	test("several types OR together", async () => {
		const text = await textOf({ keywords: ["ticket", "receipt"], limit: 20 });

		expect(text).toContain(seeded.booking as string);
		expect(text).toContain(seeded.receipt as string);
		expect(text).not.toContain(seeded.bait as string);
	});

	test("a hit renders its type as a tag, with the agent label deduplicated", async () => {
		const ticket = await textOf({ keywords: ["ticket"], limit: 20 });
		expect(ticket).toContain("tags: ticket");

		// The order carries both `$label:receipt` and `$type:order`, so both
		// render — but `$seen` never does, and neither namespace's prefix leaks.
		const order = await textOf({ keywords: ["order"], limit: 20 });
		expect(order).toMatch(TAGS_RECEIPT_RE);
		expect(order).toMatch(TAGS_ORDER_RE);
		expect(order).not.toContain("$seen");
		expect(order).not.toContain("$type:");
		expect(order).not.toContain("$label:");
	});

	// Two ticket-typed messages, a page of one: the header must report the real
	// total from Stalwart, not the page size.
	test("a full page reports the total number of matches and how many were cut off", async () => {
		const text = await textOf({ keywords: ["ticket"], limit: 1 });

		expect(
			text.startsWith("1 of 2 message(s) matched — 1 more not shown.")
		).toBe(true);
	});

	// A full page asks Stalwart for the count; it must agree nothing was cut off.
	test("a full page that holds every match reports the total without a truncation note", async () => {
		const text = await textOf({ keywords: ["ticket"], limit: 2 });

		expect(text.startsWith("2 of 2 message(s) matched:")).toBe(true);
		expect(text).not.toContain("not shown");
	});

	test("a type with no mail returns the empty-result message, not an error", async () => {
		const result = await search({ keywords: ["security_alert"], limit: 20 });

		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toBe("No messages matched.");
	});

	test("read: false finds only the unread message, through notKeyword", async () => {
		const result = await search({ limit: 20, read: false });
		const text = result.content[0]?.text ?? "";

		expect(result.isError).toBeFalsy();
		expect(text.startsWith("1 of 1 message(s) matched:")).toBe(true);
		expect(text).toContain(seeded.unread as string);
		expect(text).toContain("flags: unread");
	});

	test("read: true leaves the unread message out", async () => {
		const text = await textOf({ limit: 20, read: true });

		expect(text).toContain(seeded.booking as string);
		expect(text).not.toContain(seeded.unread as string);
	});

	test("starred: true finds only the starred message and shows its flag", async () => {
		const text = await textOf({ limit: 20, starred: true });

		expect(text.startsWith("1 of 1 message(s) matched:")).toBe(true);
		expect(text).toContain(seeded.starred as string);
		expect(text).toContain("flags: starred");
	});

	test("read composes with the other filters", async () => {
		const result = await search({
			keywords: ["ticket"],
			limit: 20,
			read: false,
		});

		expect(result.content[0]?.text).toBe("No messages matched.");
	});

	// --- paging — kept last: it adds mail the counts above don't expect.

	// Walk every page of one search, calling `between` after each page, and
	// return the ids in the order they were shown.
	const walk = async (
		args: Omit<Parameters<typeof searchEmails>[1]["args"], "cursor">,
		between: (pageIds: string[]) => Promise<void> = () => Promise.resolve()
	): Promise<{ ids: string[]; pages: number }> => {
		const ids: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const result = await search({ ...args, ...(cursor ? { cursor } : {}) });
			expect(result.isError).toBeFalsy();
			const text = result.content[0]?.text ?? "";
			const pageIds = [...text.matchAll(HIT_ID_RE)].map((m) => m[1] as string);
			ids.push(...pageIds);
			pages += 1;
			await between(pageIds);
			cursor = CURSOR_RE.exec(text)?.[1];
		} while (cursor && pages < 20);
		return { ids, pages };
	};

	const setSeen = async (id: string): Promise<void> => {
		await jmapCall(session, "Email/set", {
			update: { [id]: { "keywords/$seen": true } },
		});
	};

	test("pages of two cover every seeded message once, seven of them sharing one received second", async () => {
		const { ids, pages } = await walk({
			after: new Date(run - 60 * DAY_MS).toISOString(),
			limit: 2,
		});

		expect(pages).toBeGreaterThan(1);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(Object.values(seeded).sort());
	});

	test("mail arriving between pages neither repeats nor skips a hit", async () => {
		let arrived: string | undefined;
		const { ids } = await walk(
			{ after: new Date(run - 60 * DAY_MS).toISOString(), limit: 3 },
			async () => {
				arrived ??= await importEmail({
					body: "Fresh in while the agent was paging.",
					from: "Courier <news@courier.example>",
					keywords: { $seen: true },
					receivedAt: new Date(),
					subject: "Arrived mid-walk",
				});
			}
		);

		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(Object.values(seeded).sort());
		// Newer than the walk's first page, so it belongs to the next search.
		expect(ids).not.toContain(arrived as string);
		seeded.arrived = arrived as string;
	});

	test("marking each unread page read does not cost the next page a hit", async () => {
		for (const [i, days] of [5, 6, 7].entries()) {
			seeded[`unread${i}`] = await importEmail({
				body: "Another unread notice.",
				from: "Network <messages@network.example>",
				keywords: {},
				receivedAt: new Date(run - days * DAY_MS),
				subject: `Unread notice ${i}`,
			});
		}
		const unread = [
			seeded.unread,
			seeded.unread0,
			seeded.unread1,
			seeded.unread2,
		] as string[];

		const { ids, pages } = await walk(
			{ limit: 1, read: false },
			async (pageIds) => {
				for (const id of pageIds) {
					await setSeen(id);
				}
			}
		);

		expect(pages).toBe(4);
		expect([...ids].sort()).toEqual([...unread].sort());
	});

	test("a multi-term walk lists the older full match before the newer partial one", async () => {
		// Stalwart indexes full text a moment after import; wait until both
		// matches are searchable so the walk sees the whole result.
		await pollUntil(
			() => textOf({ limit: 20, query: "Quiet seats" }),
			(found) => found.startsWith("2 of 2"),
			{
				intervalMs: INDEX_POLL_MS,
				timeoutMs: INDEX_BUDGET_MS,
				waitingFor: 'both "Quiet seats" matches to be searchable',
			}
		);

		// The six-week-old show holds both terms; the newer booking only "seats".
		const { ids, pages } = await walk({ limit: 1, query: "Quiet seats" });

		expect(pages).toBe(2);
		expect(ids).toEqual([seeded.oldTicket, seeded.booking].map(String));
	});

	// A quoted phrase reaches Stalwart quoted, so it matches the words only
	// next to each other and in order — not a message holding them apart.
	// Imported last and kept out of `seeded`, so the walks above are unaffected.
	test("a quoted phrase matches the phrase, not the same words apart", async () => {
		const phrase = await importEmail({
			body: "Thanks for visiting Quillfern Teapot Atelier today.",
			from: "Shop <hello@shop.example>",
			keywords: { $seen: true },
			receivedAt: bookingReceivedAt,
			subject: "Your visit",
		});
		const apart = await importEmail({
			body: "The atelier sold me a teapot glazed in quillfern green.",
			from: "Forum <digest@forum.example>",
			keywords: { $seen: true },
			receivedAt: bookingReceivedAt,
			subject: "Weekly digest",
		});
		// Both hold all three words, which the unquoted search proves once
		// Stalwart has indexed them.
		const loose = await pollUntil(
			() => textOf({ limit: 20, query: "quillfern teapot atelier" }),
			(found) => found.startsWith("2 of 2"),
			{
				intervalMs: INDEX_POLL_MS,
				timeoutMs: INDEX_BUDGET_MS,
				waitingFor: "both quillfern messages to be searchable",
			}
		);
		expect(loose).toContain(phrase);
		expect(loose).toContain(apart);

		const text = await textOf({
			limit: 20,
			query: '"quillfern teapot atelier"',
		});

		expect(text.startsWith("1 of 1 message(s) matched:")).toBe(true);
		expect([...text.matchAll(HIT_ID_RE)].map((m) => m[1])).toEqual([phrase]);
		expect(apart).not.toBe(phrase);
	});
});
