// E2E for search_contacts against a REAL Stalwart: the collection pipeline
// (observation extraction → fold → ContactCard/set over JMAP for Contacts)
// seeds the collected address book the way a mail-header collector and the
// calendar write-through do, and the tool is then driven through its live
// JMAP + CalDAV deps — proving Stalwart answers AddressBook/ContactCard
// methods with no extra configuration and that the stored record ids hydrate
// back into human-readable interaction lines.
//
// The tool receives the account's Basic app-password credential as its
// token, the complete Authorization header, exactly as the server hands it
// to it. Nothing is pinned or stubbed between the tool and Stalwart.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	type CalDavConfig,
	discoverAccount,
	putEvent,
} from "../src/caldav/client.ts";
import { buildInvite } from "../src/caldav/ical.ts";
import {
	COLLECTED_BOOK_NAME,
	collectContacts,
	liveCollectionDeps,
	observationsFromEmail,
	observationsFromEvent,
	readCollected,
	toCardAddress,
	toCardPhone,
} from "../src/contacts/index.ts";
import {
	addressBookList,
	contactCardCreate,
	contactCardGet,
	contactCardPage,
	contactCardQuery,
	makeJmapLive,
} from "../src/jmap/index.ts";
import {
	makeLiveDeps,
	type SearchContactsDeps,
	searchContacts,
	searchContactsInput,
} from "../src/tools/search-contacts.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import { importEmail, openMailSession } from "./support/mail.ts";
import { untilIndexed } from "./support/wait.ts";

const DAY_MS = 86_400_000;
// Other suites load the same server, so indexing can lag well past its
// usual fraction of a second.
const INDEX_TIMEOUT_MS = 30_000;

const COLLECTION_HREF = /<D:href>([^<]+\/)<\/D:href>/giu;
const CARD_HREF = /<D:href>([^<]+[^/])<\/D:href>/giu;
const ROLE_LINE = /^ROLE[;:].*lawyer\r?$/mu;

live(
	"search_contacts against live Stalwart — collect from mail + calendar, then resolve",
	() => {
		const run = Date.now();
		const eventUid = `evt-lunch-${run}@example.com`;
		const receivedAt = new Date(run - 4 * DAY_MS).toISOString();
		const eventStart = new Date(run + 3 * DAY_MS).toISOString();
		let address: string;
		let authorization: string;
		// What the tool receives: the complete Authorization header value.
		let TOKEN: string;
		let accountId: string;
		let apiUrl: string;
		let emailId: string;
		let calendarUrl: string;
		let caldavCfg: CalDavConfig;
		let ctx: { accountId: string; apiUrl: string; authorization: string };
		let searchDeps: SearchContactsDeps;
		let selfAddresses: Set<string>;

		// The collection call a mail-header collector makes for a batch of new mail.
		const collectFromRobinEmail = () =>
			collectContacts(
				liveCollectionDeps,
				ctx,
				observationsFromEmail(
					{
						cc: [
							{
								email: "messaging-digest-noreply@linkedin.com",
								name: "LinkedIn",
							},
						],
						from: [
							{ email: "Robin@northwind.example", name: "Robin Fairweather" },
						],
						id: emailId,
						receivedAt,
						to: [{ email: address }],
					},
					{ selfAddresses }
				)
			);

		beforeAll(async () => {
			const account = await createAccount({
				localPart: uniqueLocalPart("mcp-contacts-e2e"),
			});
			address = account.address;
			authorization = account.authorization;
			TOKEN = account.authorization;
			selfAddresses = new Set([address]);

			const session = await openMailSession(authorization);
			apiUrl = session.apiUrl;
			const jmapLive = makeJmapLive(ADMIN_URL);
			accountId = await jmapLive.resolveAccountId(authorization);
			expect(accountId).toBe(session.accountId);
			ctx = { accountId, apiUrl, authorization };

			// Seed 1 — mail: a direct message from Robin with a relay CC'd, imported
			// for real so subject hydration reads it back over Email/get.
			emailId = await importEmail(session, {
				raw: [
					"From: Robin Fairweather <robin@northwind.example>",
					`To: ${address}`,
					"Cc: LinkedIn <messaging-digest-noreply@linkedin.com>",
					"Subject: Northwind onboarding",
					`Message-ID: <1-${run}@mcp-contacts-e2e>`,
					"Date: Tue, 21 Jul 2026 10:00:00 +0000",
					"",
					"Welcome aboard!",
				].join("\r\n"),
				receivedAt: new Date(receivedAt),
			});
			await collectFromRobinEmail();

			// Seed 2 — calendar: a real event PUT to the default calendar (silent:
			// no invitation is sent), then the same write-through fold the
			// calendar tools run after a successful scheduling action.
			caldavCfg = { serverUrl: ADMIN_URL };
			const discovered = await discoverAccount(caldavCfg, TOKEN);
			if (!discovered.defaultCalendarUrl) {
				throw new Error("no default calendar on the throwaway account");
			}
			calendarUrl = discovered.defaultCalendarUrl;
			const ical = buildInvite({
				attendees: ["robin@northwind.example"],
				end: new Date(new Date(eventStart).getTime() + 60 * 60 * 1000),
				organizer: address,
				scheduleAgent: "NONE",
				start: new Date(eventStart),
				title: "Lunch — Kim & Robin",
				uid: eventUid,
			});
			await putEvent(caldavCfg, { calendarUrl, ical, token: TOKEN });
			await collectContacts(
				liveCollectionDeps,
				ctx,
				observationsFromEvent(
					{
						attendees: [{ email: "robin@northwind.example" }],
						organizer: address,
						start: eventStart,
						uid: eventUid,
					},
					{ kind: "action", selfAddresses }
				)
			);

			// The tool's own live wiring: JMAP through the session cache, event
			// titles over CalDAV from every calendar of the account.
			searchDeps = makeLiveDeps(jmapLive, caldavCfg);
		});

		// Throwaway principal; destroying it also drops its mail, calendar, and
		// contact data.
		afterAll(destroyCreatedAccounts);

		test("collection provisioned the Collected book and exactly one card for Robin", async () => {
			const books = await addressBookList(ctx);
			expect(books.map((b) => b.name)).toContain(COLLECTED_BOOK_NAME);
			const ids = await untilIndexed(
				() =>
					contactCardQuery({
						...ctx,
						filter: { email: "robin@northwind.example" },
					}),
				(found) => found.length > 0,
				"the collected card by email",
				INDEX_TIMEOUT_MS
			);
			expect(ids).toHaveLength(1);
			const [card] = await contactCardGet({ ...ctx, ids });
			expect(card?.name?.full).toBe("Robin Fairweather");
			const ext = readCollected(card as NonNullable<typeof card>);
			// Mail sighting (strong) upgraded to confirmed by the scheduling action.
			expect(ext.addresses["robin@northwind.example"]?.confidence).toBe(
				"confirmed"
			);
			expect(ext.addresses["robin@northwind.example"]?.count).toBe(2);
			expect(ext.relays).toEqual(["messaging-digest-noreply@linkedin.com"]);
		});

		test("a pre-existing card WITHOUT notes still accumulates collection data in place", async () => {
			// The personal-book case: a user-created card has no notes property, so
			// the fold must emit a full top-level notes set (RFC 8620 rejects a
			// scoped patch path whose parent is missing).
			const books = await addressBookList(ctx);
			const bookId = books.find((b) => b.isDefault)?.id ?? books[0]?.id;
			if (!bookId) {
				throw new Error("no address book on the throwaway account");
			}
			const cardId = await contactCardCreate({
				...ctx,
				card: {
					addressBookIds: { [bookId]: true },
					emails: { e0: { address: "plain@example.com" } },
					name: { full: "Plain Person" },
					uid: `plain-${run}`,
					version: "1.0",
				},
			});
			await untilIndexed(
				() =>
					contactCardQuery({ ...ctx, filter: { email: "plain@example.com" } }),
				(found) => found.includes(cardId),
				"the personal-book card by email",
				INDEX_TIMEOUT_MS
			);
			await collectContacts(
				liveCollectionDeps,
				ctx,
				observationsFromEmail(
					{
						from: [{ email: "plain@example.com", name: "Plain Person" }],
						id: `m-plain-${run}`,
						receivedAt,
						to: [{ email: address }],
					},
					{ selfAddresses }
				)
			);
			const [card] = await contactCardGet({ ...ctx, ids: [cardId] });
			const ext = readCollected(card as NonNullable<typeof card>);
			expect(ext.addresses["plain@example.com"]?.count).toBe(1);
			// No duplicate was created for the address.
			const ids = await contactCardQuery({
				...ctx,
				filter: { email: "plain@example.com" },
			});
			expect(ids).toEqual([cardId]);
		});

		test("re-collecting the same mail batch never double-counts or duplicates", async () => {
			await collectFromRobinEmail();
			const ids = await contactCardQuery({
				...ctx,
				filter: { email: "robin@northwind.example" },
			});
			expect(ids).toHaveLength(1);
			const [card] = await contactCardGet({ ...ctx, ids });
			const ext = readCollected(card as NonNullable<typeof card>);
			expect(ext.addresses["robin@northwind.example"]?.count).toBe(2);
		});

		test('concise: resolves "Robin" to the confirmed work address with hydrated interactions', async () => {
			const result = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({ query: "robin" }),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("1 person(s) matched");
			expect(text).toContain("Robin Fairweather");
			expect(text).toContain("best_address: robin@northwind.example (work)");
			expect(text).toContain("address_confidence: confirmed");
			expect(text).toContain("calendar: Lunch — Kim & Robin");
			expect(text).toContain("email received: Northwind onboarding");
			expect(text).toContain("relay addresses");
		});

		test("detailed: adds record ids for chaining and the excluded relay", async () => {
			const result = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({
					query: "northwind",
					response_format: "detailed",
				}),
				token: TOKEN,
			});
			const text = result.content[0]?.text ?? "";
			expect(text).toContain(`[event uid: ${eventUid}]`);
			expect(text).toContain(`[email id: ${emailId}]`);
			expect(text).toContain(
				"excluded_relays: messaging-digest-noreply@linkedin.com"
			);
		});

		test("a personal card duplicating a Collected one absorbs it on the next sighting", async () => {
			const sam = "sam.twin@example.com";
			const fromSam = (id: string) =>
				collectContacts(
					liveCollectionDeps,
					ctx,
					observationsFromEmail(
						{
							from: [{ email: sam, name: "Sam Twin" }],
							id,
							receivedAt,
							to: [{ email: address }],
						},
						{ selfAddresses }
					)
				);
			await fromSam(`m-sam-1-${run}`);
			const [collectedId] = await untilIndexed(
				() => contactCardQuery({ ...ctx, filter: { email: sam } }),
				(found) => found.length === 1,
				"the Collected card for Sam",
				INDEX_TIMEOUT_MS
			);
			// The import: a personal-book card for the same address, with a phone.
			const books = await addressBookList(ctx);
			const bookId = books.find((b) => b.name !== COLLECTED_BOOK_NAME)?.id;
			if (!bookId) {
				throw new Error("no personal address book on the throwaway account");
			}
			const personalId = await contactCardCreate({
				...ctx,
				card: {
					addressBookIds: { [bookId]: true },
					emails: { e0: { address: sam } },
					name: { full: "Sam Twin" },
					phones: {
						p0: toCardPhone({ label: "mobile", number: "+49 151 9876543" }),
					},
					uid: `sam-twin-${run}`,
					version: "1.0",
				},
			});
			await untilIndexed(
				() => contactCardQuery({ ...ctx, filter: { email: sam } }),
				(found) => found.includes(personalId) && found.length === 2,
				"both cards for Sam",
				INDEX_TIMEOUT_MS
			);

			await fromSam(`m-sam-2-${run}`);

			expect(
				await contactCardGet({ ...ctx, ids: [collectedId as string] })
			).toEqual([]);
			const [personal] = await contactCardGet({ ...ctx, ids: [personalId] });
			expect(
				readCollected(personal as NonNullable<typeof personal>).addresses[sam]
					?.count
			).toBe(2);
			await untilIndexed(
				() => contactCardQuery({ ...ctx, filter: { email: sam } }),
				(found) => found.length === 1 && found[0] === personalId,
				"the Collected card dropping out of the index",
				INDEX_TIMEOUT_MS
			);
			const result = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({
					query: "Twin",
					response_format: "detailed",
				}),
				token: TOKEN,
			});
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("1 person(s) matched");
			expect(text).toContain("+49 151 9876543");
			expect(text).toContain(`[email id: m-sam-1-${run}]`);
			// Three index waits of up to INDEX_TIMEOUT_MS each.
		}, 120_000);

		test("an unknown name gets the instructive empty result", async () => {
			const result = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({ query: `zz-nobody-${run}` }),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("No contact matched");
		});

		// Last, because it fills the book with 300 cards. Stalwart's query cannot
		// match a role (`text` does not search `titles`, and there is no title
		// condition), so the whole-book sweep is the only read that reaches the role card.
		test("cards past position 300 are found: one with no email by name, one by its role alone", async () => {
			const [book] = (await addressBookList(ctx)).filter(
				(b) => b.name !== COLLECTED_BOOK_NAME
			);
			const bookId = (book as NonNullable<typeof book>).id;
			const create: Record<string, unknown> = {};
			for (let i = 0; i < 300; i += 1) {
				create[`f${i}`] = {
					addressBookIds: { [bookId]: true },
					emails: { e0: { address: `filler-${i}@example.org` } },
					name: { full: `Filler ${i}` },
				};
			}
			const res = await fetch(apiUrl, {
				body: JSON.stringify({
					methodCalls: [["ContactCard/set", { accountId, create }, "0"]],
					using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
				}),
				headers: { authorization, "content-type": "application/json" },
				method: "POST",
			});
			expect(res.status).toBe(200);
			const lawyerId = await contactCardCreate({
				...ctx,
				card: {
					addressBookIds: { [bookId]: true },
					emails: { e0: { address: "robin@fairweather-law.example" } },
					name: { full: "Robin Lawyer-Card" },
					titles: { r0: { kind: "role", name: "lawyer" } },
					uid: `role-card-${run}`,
				},
			});
			// What create_contact writes from a name and a postal address.
			const henrikeId = await contactCardCreate({
				...ctx,
				card: {
					addressBookIds: { [bookId]: true },
					addresses: {
						a0: toCardAddress({
							city: "Berlin",
							label: "home",
							street: "Beispielweg 1",
						}),
					},
					name: { full: "Henrike Wolters" },
					uid: `no-email-${run}`,
				},
			});

			// The upstream gap itself: once the index has the card (found by name),
			// a word that is only in its title is still not found. When this turns
			// red, Stalwart searches titles and the whole-book sweep in
			// search_contacts is no longer the only way to reach a role.
			const titleWord = `zzrole${run}`;
			const titleOnlyId = await contactCardCreate({
				...ctx,
				card: {
					addressBookIds: { [bookId]: true },
					name: { full: `Title Probe ${run}` },
					titles: { r0: { kind: "role", name: titleWord } },
				},
			});
			await untilIndexed(
				() => contactCardQuery({ ...ctx, filter: { text: `Probe ${run}` } }),
				(found) => found.includes(titleOnlyId),
				"the title probe card reaching the index",
				INDEX_TIMEOUT_MS
			);
			expect(
				await contactCardQuery({ ...ctx, filter: { text: titleWord } })
			).toEqual([]);

			// Both cards really are past position 300 of the unfiltered order.
			const order = await contactCardQuery({ ...ctx, limit: 1000 });
			expect(order.indexOf(lawyerId)).toBeGreaterThan(300);
			expect(order.indexOf(henrikeId)).toBeGreaterThan(300);
			// The sweep's narrow page: one request, only the asked-for properties.
			const page = await contactCardPage({
				...ctx,
				limit: 500,
				position: 0,
				properties: ["id", "name", "titles"],
			});
			expect(page.total).toBe(order.length);
			const narrow = page.cards.find((c) => c.id === lawyerId);
			expect(narrow?.titles).toEqual({ r0: { kind: "role", name: "lawyer" } });
			expect(narrow?.emails).toBeUndefined();

			const byRole = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({ query: "my lawyer" }),
				token: TOKEN,
			});
			const text = byRole.content[0]?.text ?? "";
			expect(text).toContain("1. Robin Lawyer-Card");
			expect(text).toContain("roles: lawyer");

			const byName = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({ query: "Wolters" }),
				token: TOKEN,
			});
			expect(byName.content[0]?.text).toContain("1 person(s) matched");
			expect(byName.content[0]?.text).toContain(`contact_id: ${henrikeId}`);

			// Over CardDAV the role is an ordinary vCard field, not a group.
			const home = `${ADMIN_URL}/dav/card/${encodeURIComponent(address)}/`;
			const listing = await (
				await fetch(home, {
					headers: { authorization, depth: "1" },
					method: "PROPFIND",
				})
			).text();
			const books = [...listing.matchAll(COLLECTION_HREF)]
				.map((m) => m[1])
				.filter((h) => h !== new URL(home).pathname);
			const vcards: string[] = [];
			for (const href of books) {
				const inBook = await (
					await fetch(`${ADMIN_URL}${href}`, {
						headers: { authorization, depth: "1" },
						method: "PROPFIND",
					})
				).text();
				for (const [, card] of inBook.matchAll(CARD_HREF)) {
					const body = await (
						await fetch(`${ADMIN_URL}${card}`, { headers: { authorization } })
					).text();
					if (body.includes("Robin Lawyer-Card")) {
						vcards.push(body);
					}
				}
			}
			expect(vcards).toHaveLength(1);
			expect(vcards[0]).toMatch(ROLE_LINE);
			expect(vcards[0]).not.toContain("CATEGORIES");
		}, 120_000);
	}
);
