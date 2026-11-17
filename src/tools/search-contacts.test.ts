import { describe, expect, test } from "vitest";

import {
	birthAnniversary,
	COLLECTED_BOOK_NAME,
	COLLECTED_NOTE_KEY,
	collectContacts,
	collectedNoteEntry,
	toCardAddress,
	toCardPhone,
	USER_NOTE_KEY,
} from "../contacts/index.ts";
import type { ContactCard } from "../jmap/index.ts";

import { fakeBook } from "./contact-test-fixtures.ts";
import {
	type SearchContactsDeps,
	searchContacts,
	searchContactsInput,
} from "./search-contacts.ts";

const DAY_MS = 86_400_000;
const ALEX_ACTIVE_FIRST = /^5 person\(s\) matched:\n\n1\. Alex Active\n/u;
const LAWYER_FIRST =
	/^3 person\(s\) matched:\n\n1\. Robin Fairweather\n {3}contact_id: card-lawyer\n {3}roles: lawyer/u;
const daysAgo = (n: number): string =>
	new Date(Date.now() - n * DAY_MS).toISOString();

const robinCard = (over: Partial<ContactCard> = {}): ContactCard =>
	({
		addressBookIds: { collected: true },
		emails: {
			e0: { address: "robin@northwind.example", contexts: { work: true } },
			e1: { address: "robin.private@gmail.com", contexts: { private: true } },
		},
		id: "card-robin",
		name: { full: "Robin Fairweather" },
		notes: {
			[COLLECTED_NOTE_KEY]: collectedNoteEntry({
				addresses: {
					"robin.private@gmail.com": {
						confidence: "weak",
						count: 1,
						firstSeen: daysAgo(200),
						lastSeen: daysAgo(200),
					},
					"robin@northwind.example": {
						confidence: "confirmed",
						count: 4,
						firstSeen: daysAgo(90),
						lastSeen: daysAgo(4),
					},
				},
				interactions: [
					{
						channel: "calendar",
						date: daysAgo(4),
						direction: "outgoing",
						recordId: "evt-lunch@example.com",
					},
					{
						channel: "email",
						date: daysAgo(24),
						direction: "incoming",
						recordId: "mail-1",
					},
					{
						channel: "email",
						date: daysAgo(49),
						direction: "outgoing",
						recordId: "mail-2",
					},
				],
				relays: ["messaging-digest-noreply@linkedin.com"],
			}),
		},
		...over,
	}) as ContactCard;

// One page of `cards` as Stalwart serves it: at most `serverLimit` ids per
// query, only the requested properties, and the total. Refuses a read of
// more than 500 ids, as Stalwart's `maxObjectsInGet` does.
const pagesOf =
	(
		cards: ContactCard[],
		serverLimit = 5000
	): SearchContactsDeps["contactCardPage"] =>
	(p) => {
		if (p.limit > 500) {
			return Promise.reject(new Error("maxObjectsInGet"));
		}
		const slice = cards.slice(
			p.position,
			p.position + Math.min(p.limit, serverLimit)
		);
		const narrow = slice.map(
			(c) =>
				Object.fromEntries(
					Object.entries(c).filter(([k]) => p.properties.includes(k))
				) as ContactCard
		);
		return Promise.resolve({
			cards: narrow,
			returned: slice.length,
			total: cards.length,
		});
	};

const makeDeps = (
	cards: ContactCard[],
	over: Partial<SearchContactsDeps> = {}
): SearchContactsDeps => ({
	addressBookList: () =>
		Promise.resolve([{ id: "book-collected", name: COLLECTED_BOOK_NAME }]),
	contactCardGet: (p) =>
		p.ids.length > 500
			? Promise.reject(new Error("maxObjectsInGet"))
			: Promise.resolve(cards.filter((c) => p.ids.includes(c.id))),
	contactCardPage: pagesOf(cards),
	emailGet: (p) =>
		Promise.resolve(
			p.ids.map((id) => ({
				id,
				subject: id === "mail-1" ? "Northwind onboarding" : "Follow-up",
			}))
		),
	fetchEventTitles: (_token, uids) =>
		Promise.resolve(
			new Map(uids.map((uid) => [uid, "Lunch — Dominik & Robin"]))
		),
	resolveAccountId: () => Promise.resolve("acct"),
	resolveMailAccountId: () => Promise.resolve("acct"),
	...over,
});

const args = (over: Record<string, unknown> = {}) =>
	searchContactsInput.parse({ query: "robin", ...over });

describe("searchContacts — concise", () => {
	test("the Robin case: confirmed work address, computed relationship, hydrated interactions", async () => {
		const result = await searchContacts(makeDeps([robinCard()]), {
			args: args(),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(result.isError).toBeUndefined();
		expect(text).toContain("Robin Fairweather");
		expect(text).toContain("best_address: robin@northwind.example (work)");
		expect(text).toContain(
			"address_confidence: confirmed | relationship: active"
		);
		expect(text).toContain("4 days ago — calendar: Lunch — Dominik & Robin");
		expect(text).toContain(
			"24 days ago — email received: Northwind onboarding"
		);
		// Concise never exposes raw counts or record ids.
		expect(text).not.toContain("count");
		expect(text).not.toContain("evt-lunch@example.com");
		// But it does flag that a relay was excluded.
		expect(text).toContain("relay addresses");
	});

	test("a private context bias flips the best address without dropping the person", async () => {
		const result = await searchContacts(makeDeps([robinCard()]), {
			args: args({ context: "private" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("best_address: robin.private@gmail.com (private)");
		expect(text).toContain("address_confidence: weak");
	});

	test("a preferred address comes first, unless a context asks for the other kind", async () => {
		const pinned = robinCard({
			emails: {
				e0: { address: "robin@northwind.example", contexts: { work: true } },
				e1: {
					address: "robin.private@gmail.com",
					contexts: { private: true },
					pref: 1,
				},
			},
		});
		const any =
			(await searchContacts(makeDeps([pinned]), { args: args(), token: "tok" }))
				.content[0]?.text ?? "";
		expect(any).toContain("best_address: robin.private@gmail.com (private)");
		const work = await searchContacts(makeDeps([pinned]), {
			args: args({ context: "work" }),
			token: "tok",
		});
		expect(work.content[0]?.text).toContain(
			"best_address: robin@northwind.example (work)"
		);
		const detailed = await searchContacts(makeDeps([pinned]), {
			args: args({ response_format: "detailed" }),
			token: "tok",
		});
		expect(detailed.content[0]?.text).toContain(
			"- robin.private@gmail.com (private, weak, preferred,"
		);
	});

	test("empty result names the sources and steers the next attempt", async () => {
		const result = await searchContacts(makeDeps([]), {
			args: args({ query: "nonexistent" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain('No contact matched "nonexistent"');
		expect(text).toContain("collected address book");
		expect(text).toContain("LinkedIn or another platform");
	});

	test("truncation names the total and invites a narrower query", async () => {
		const cards = Array.from({ length: 7 }, (_, i) =>
			robinCard({
				emails: { e0: { address: `robin${i}@corp${i}.example` } },
				id: `card-${i}`,
				name: { full: `Robin Number${i}` },
			})
		);
		const result = await searchContacts(makeDeps(cards), {
			args: args({ limit: 3 }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("3 person(s) matched");
		expect(text).toContain("Showing the top 3 of 7 matches");
	});

	test("a personal card duplicating a Collected one is one entry after the next sighting", async () => {
		// The pair a contact import leaves: the personal card holds the details,
		// the Collected card the history. Collection merges them.
		const personal: ContactCard = {
			addressBookIds: { "ab-personal": true },
			addresses: {
				a0: toCardAddress({
					city: "München",
					label: "home",
					street: "Beispielweg 1",
				}),
			},
			anniversaries: { b0: birthAnniversary({ day: 14, month: 3 }) },
			emails: { e0: { address: "robin@northwind.example" } },
			id: "card-personal",
			name: { full: "Robin Fairweather" },
			phones: {
				p0: toCardPhone({ label: "mobile", number: "+49 151 2345678" }),
			},
		};
		const collected = robinCard({ addressBookIds: { "book-collected": true } });
		const book = fakeBook(
			[collected, personal],
			[
				{ id: "book-collected", name: COLLECTED_BOOK_NAME },
				{ id: "ab-personal", name: "Contacts" },
			]
		);
		await collectContacts(
			book.deps,
			{ accountId: "acct", apiUrl: "", authorization: "Bearer tok" },
			{
				observations: [
					{
						address: "robin@northwind.example",
						channel: "email",
						confidence: "strong",
						date: daysAgo(1),
						direction: "incoming",
						name: "Robin Fairweather",
						recordId: "mail-3",
					},
				],
				relays: [],
			}
		);
		expect([...book.cards.keys()]).toEqual(["card-personal"]);

		const result = await searchContacts(makeDeps([...book.cards.values()]), {
			args: args({ response_format: "detailed" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("1 person(s) matched");
		expect(text).toContain("+49 151 2345678");
		expect(text).toContain("Beispielweg 1");
		expect(text).toContain("birthday: --03-14");
		expect(text).toContain("source: imported");
		// The collected history, now on the personal card.
		expect(text).toContain("mail-1");
		expect(text).toContain("mail-3");
		expect(text).toContain("robin.private@gmail.com");
	});

	test("an old Collected card without a marker prints source: derived", async () => {
		// robinCard carries no source marker and no collected uid; only its book
		// says collection wrote it.
		const result = await searchContacts(
			makeDeps([robinCard({ addressBookIds: { "book-collected": true } })]),
			{
				args: args({ response_format: "detailed" }),
				token: "tok",
			}
		);
		expect(result.content[0]?.text).toContain("source: derived");
	});

	test("same-name people stay separate entries, ranked by relationship then recency", async () => {
		const other = robinCard({
			emails: { e0: { address: "robin@elsewhere.example" } },
			id: "card-other",
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry({
					addresses: {
						"robin@elsewhere.example": {
							confidence: "strong",
							count: 1,
							firstSeen: daysAgo(10),
							lastSeen: daysAgo(10),
						},
					},
					interactions: [
						{
							channel: "email",
							date: daysAgo(10),
							direction: "incoming",
							recordId: "mail-9",
						},
					],
				}),
			},
		});
		const result = await searchContacts(makeDeps([other, robinCard()]), {
			args: args(),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("2 person(s) matched");
		// The active Robin (card-robin) ranks above the incidental one.
		expect(text.indexOf("robin@northwind.example")).toBeLessThan(
			text.indexOf("robin@elsewhere.example")
		);
	});

	test("cards the query does not match are not returned", async () => {
		const unrelated = robinCard({
			emails: { e0: { address: "someone@else.example" } },
			id: "card-unrelated",
			name: { full: "Someone Else" },
		});
		const result = await searchContacts(makeDeps([robinCard(), unrelated]), {
			args: args(),
			token: "tok",
		});
		expect(result.content[0]?.text).toContain("1 person(s) matched");
	});

	test("finds a contact that has no email address at all, by name", async () => {
		// The shape create_contact can write: a name and a postal address,
		// nobody's mail header involved.
		const authored = robinCard({
			addresses: {
				a0: toCardAddress({
					city: "München",
					label: "home",
					street: "Beispielweg 1",
				}),
			},
			emails: {},
			id: "card-authored",
		});
		const result = await searchContacts(makeDeps([robinCard(), authored]), {
			args: args({ query: "Fairweather" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("2 person(s) matched");
		expect(text).toContain("contact_id: card-robin");
		expect(text).toContain("contact_id: card-authored");
	});

	test("a word only in the shared collection note is not a match", async () => {
		// Every collected card carries the same machine-written note, so a note
		// hit would return the whole book for a word from it.
		const result = await searchContacts(makeDeps([robinCard()]), {
			args: args({ query: "Maintained" }),
			token: "tok",
		});
		expect(result.content[0]?.text).toContain(
			'No contact matched "Maintained"'
		);
	});

	test("matches on an organization name and shows it", async () => {
		const withOrg = robinCard({ organizations: { o0: { name: "Northwind" } } });
		const result = await searchContacts(makeDeps([withOrg]), {
			args: args({ query: "northwind" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("1 person(s) matched");
		expect(text).toContain("organization: Northwind");
	});

	test("hydration failures degrade lines instead of failing the search", async () => {
		const deps = makeDeps([robinCard()], {
			emailGet: () => Promise.reject(new Error("jmap down")),
			fetchEventTitles: () => Promise.reject(new Error("caldav down")),
		});
		const result = await searchContacts(deps, { args: args(), token: "tok" });
		const text = result.content[0]?.text ?? "";
		expect(result.isError).toBeUndefined();
		expect(text).toContain("(event no longer available)");
		expect(text).toContain("(message no longer available)");
	});
});

describe("searchContacts — detailed", () => {
	test("adds every address, record ids for chaining, and excluded relays", async () => {
		const result = await searchContacts(makeDeps([robinCard()]), {
			args: args({ response_format: "detailed" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("robin@northwind.example (work, confirmed");
		expect(text).toContain("robin.private@gmail.com (private, weak");
		expect(text).toContain("[event uid: evt-lunch@example.com]");
		expect(text).toContain("[email id: mail-1]");
		expect(text).toContain(
			"excluded_relays: messaging-digest-noreply@linkedin.com"
		);
	});

	test("surfaces the authored half of the record with handles the write tools take", async () => {
		const card = robinCard({
			addresses: {
				a0: toCardAddress({
					city: "München",
					country: "DE",
					label: "home",
					postalCode: "80331",
					street: "Beispielweg 1",
				}),
			},
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry({
					addresses: {},
					interactions: [],
					source: "derived",
				}),
				[USER_NOTE_KEY]: { note: "Prefers letters." },
			},
			phones: {
				p0: toCardPhone({ label: "mobile", number: "+49 89 1234567" }),
			},
		});
		const result = await searchContacts(makeDeps([card]), {
			args: args({ response_format: "detailed" }),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("[p0] +49 89 1234567 (mobile)");
		expect(text).toContain("[a0] Beispielweg 1, 80331 München, DE (home)");
		expect(text).toContain("note: Prefers letters.");
		expect(text).toContain("source: derived");
	});

	test("the birthday shows once in the concise format and once in the detailed format", async () => {
		const card = robinCard({
			anniversaries: {
				b: { date: { day: 3, month: 3, year: 1990 }, kind: "birth" },
			},
		});
		const concise = await searchContacts(makeDeps([card]), {
			args: args(),
			token: "tok",
		});
		const conciseText = concise.content[0]?.text ?? "";
		expect(conciseText.split("birthday: 1990-03-03")).toHaveLength(2);

		const detailed = await searchContacts(makeDeps([card]), {
			args: args({ response_format: "detailed" }),
			token: "tok",
		});
		const detailedText = detailed.content[0]?.text ?? "";
		expect(detailedText.split("birthday: 1990-03-03")).toHaveLength(2);
	});

	test("no birthday line when none is stored", async () => {
		const result = await searchContacts(makeDeps([robinCard()]), {
			args: args(),
			token: "tok",
		});
		expect(result.content[0]?.text).not.toContain("birthday:");
	});

	test("the concise format keeps the postal address out of a name-resolution answer", async () => {
		const card = robinCard({
			addresses: { a0: toCardAddress({ city: "München", label: "home" }) },
		});
		const result = await searchContacts(makeDeps([card]), {
			args: args(),
			token: "tok",
		});
		const text = result.content[0]?.text ?? "";
		expect(text).not.toContain("postal_addresses");
		// The contact id is in both formats: editing must not cost a second call.
		expect(text).toContain("contact_id: card-robin");
	});
});

describe("searchContactsInput", () => {
	test("requires a query and bounds the limit", () => {
		expect(searchContactsInput.safeParse({}).success).toBe(false);
		expect(
			searchContactsInput.safeParse({ limit: 26, query: "x" }).success
		).toBe(false);
		const parsed = searchContactsInput.parse({ query: "robin" });
		expect(parsed.context).toBe("any");
		expect(parsed.limit).toBe(5);
		expect(parsed.response_format).toBe("concise");
	});
});

describe("searchContacts — roles", () => {
	const lawyer = (over: Partial<ContactCard> = {}): ContactCard =>
		robinCard({
			emails: { e0: { address: "robin@fairweather-law.example" } },
			id: "card-lawyer",
			notes: {},
			titles: { r0: { kind: "role", name: "lawyer" } },
			...over,
		});
	// Both decoys carry more history than the lawyer, so plain ranking alone
	// would put them first.
	const lawrence = robinCard({
		emails: { e0: { address: "lawrence@example.org" } },
		id: "card-lawrence",
		name: { full: "Lawrence Lawyerson" },
	});
	const lawhouse = robinCard({
		emails: { e0: { address: "info@lawyer-house.example" } },
		id: "card-lawhouse",
		name: { full: "Front Desk" },
	});

	test('finds the person by role, case-insensitively and with "my", ranked above name and domain hits', async () => {
		const deps = makeDeps([lawrence, lawhouse, lawyer()]);
		for (const query of ["lawyer", "My Lawyer"]) {
			const text =
				(await searchContacts(deps, { args: args({ query }), token: "tok" }))
					.content[0]?.text ?? "";
			expect(text).toMatch(LAWYER_FIRST);
			expect(text).not.toContain("as a role");
		}
	});

	test("a role nobody has says so, and names the way there", async () => {
		const empty = await searchContacts(makeDeps([robinCard()]), {
			args: args({ query: "my plumber" }),
			token: "tok",
		});
		expect(empty.content[0]?.text).toContain("no contact has it as a role");
		expect(empty.content[0]?.text).toContain("search_emails");
		expect(empty.content[0]?.text).toContain("addedRoles");
		// A domain hit is no answer to "my lawyer": flagged rather than offered as the person.
		const domainOnly = await searchContacts(makeDeps([lawhouse]), {
			args: args({ query: "my lawyer" }),
			token: "tok",
		});
		expect(domainOnly.content[0]?.text).toContain(
			'No contact has "lawyer" as a role'
		);
		// A plain name search gets no such note.
		const byName = await searchContacts(makeDeps([robinCard()]), {
			args: args({ query: "robin" }),
			token: "tok",
		});
		expect(byName.content[0]?.text).not.toContain("as a role");
	});

	const fillerCards = (n: number): ContactCard[] =>
		Array.from({ length: n }, (_, i) =>
			robinCard({
				emails: { e0: { address: `p${i}@example.org` } },
				id: `card-${i}`,
				name: { full: `Person ${i}` },
			})
		);
	// A card with no collected history, so it ranks below any card with some.
	const quiet = (id: string, name: string): ContactCard =>
		robinCard({
			emails: { e0: { address: `${id}@example.org` } },
			id,
			name: { full: name },
			notes: {},
		});

	test("finds a contact with no email address deep in a 2,000-card book by name", async () => {
		const henrike = robinCard({
			emails: {},
			id: "card-henrike",
			name: { full: "Henrike Wolters" },
		});
		const cards = [
			...fillerCards(1200),
			henrike,
			...fillerCards(2000).slice(1201),
		];
		const text =
			(
				await searchContacts(makeDeps(cards), {
					args: args({ query: "Wolters" }),
					token: "tok",
				})
			).content[0]?.text ?? "";
		expect(text).toContain("1 person(s) matched");
		expect(text).toContain("contact_id: card-henrike");
		expect(text).not.toContain("were searched");
	});

	test("finds a contact by role alone, past position 250", async () => {
		const cards = [
			...fillerCards(600),
			lawyer({ emails: {}, name: { full: "Quiet Counsel" } }),
		];
		const text =
			(
				await searchContacts(makeDeps(cards), {
					args: args({ query: "my lawyer" }),
					token: "tok",
				})
			).content[0]?.text ?? "";
		expect(text).toContain("1. Quiet Counsel");
		expect(text).toContain("roles: lawyer");
	});

	test("ranks every match: the most active of 80 comes first, and the total is exact", async () => {
		const alexes = Array.from({ length: 80 }, (_, i) =>
			quiet(`card-alex-${i}`, `Alex Number${i}`)
		);
		// Robin's card carries the active history; it sits past the 50th id.
		alexes[70] = robinCard({
			id: "card-alex-active",
			name: { full: "Alex Active" },
		});
		const cards = [...fillerCards(300), ...alexes];
		const text =
			(
				await searchContacts(makeDeps(cards), {
					args: args({ query: "alex" }),
					token: "tok",
				})
			).content[0]?.text ?? "";
		expect(text).toMatch(ALEX_ACTIVE_FIRST);
		expect(text).toContain("Showing the top 5 of 80 matches");
		expect(text).not.toContain("at least");
	});

	test("reads every page and no read asks for more than 500 ids", async () => {
		const holders = Array.from({ length: 600 }, (_, i) =>
			lawyer({ id: `card-lawyer-${i}` })
		);
		const cards = [...fillerCards(1700), ...holders];
		const asked: number[] = [];
		const pages = pagesOf(cards);
		const deps = makeDeps(cards, {
			contactCardGet: (p) => {
				asked.push(p.ids.length);
				return makeDeps(cards).contactCardGet(p);
			},
			contactCardPage: (p) => {
				asked.push(p.limit);
				return pages(p);
			},
		});
		const text =
			(
				await searchContacts(deps, {
					args: args({ query: "lawyer" }),
					token: "tok",
				})
			).content[0]?.text ?? "";
		expect(text).toContain("Showing the top 5 of 600 matches");
		expect(Math.max(...asked)).toBe(500);
	});

	test("a server that answers fewer ids than asked for still has every card read", async () => {
		const cards = [...fillerCards(1000), quiet("card-last", "Last Person")];
		let reads = 0;
		const pages = pagesOf(cards, 200);
		const deps = makeDeps(cards, {
			contactCardPage: (p) => {
				reads += 1;
				return pages(p);
			},
		});
		const text = (
			await searchContacts(deps, {
				args: args({ query: "Last Person" }),
				token: "tok",
			})
		).content[0]?.text;
		expect(text).toContain("contact_id: card-last");
		// 1,001 cards in pages of 200: six pages, no re-reads.
		expect(reads).toBe(6);
	});

	test("a server that does not count still reads to the first empty page", async () => {
		const cards = [...fillerCards(1100), quiet("card-last", "Last Person")];
		const pages = pagesOf(cards);
		const deps = makeDeps(cards, {
			contactCardPage: async (p) => {
				const { cards: got, returned } = await pages(p);
				return { cards: got, returned };
			},
		});
		const text = (
			await searchContacts(deps, {
				args: args({ query: "Last Person" }),
				token: "tok",
			})
		).content[0]?.text;
		expect(text).toContain("contact_id: card-last");
	});

	test("the match reads narrow cards, and only the matches are read in full", async () => {
		const cards = [...fillerCards(700), lawyer()];
		const properties = new Set<string>();
		const full: string[] = [];
		const pages = pagesOf(cards);
		const deps = makeDeps(cards, {
			contactCardGet: (p) => {
				full.push(...p.ids);
				return Promise.resolve(cards.filter((c) => p.ids.includes(c.id)));
			},
			contactCardPage: (p) => {
				for (const property of p.properties) {
					properties.add(property);
				}
				return pages(p);
			},
		});
		await searchContacts(deps, {
			args: args({ query: "lawyer" }),
			token: "tok",
		});
		expect([...properties].sort()).toEqual([
			"emails",
			"id",
			"name",
			"organizations",
			"titles",
		]);
		expect(full).toEqual(["card-lawyer"]);
	});

	test("a book past the cap gets one note saying a contact may be missing", async () => {
		// The lawyer sits past the 50,000 cards the sweep reads.
		const cards = [...fillerCards(50_100), lawyer()];
		const deps = makeDeps(cards);
		const empty = (
			await searchContacts(deps, {
				args: args({ query: "my lawyer" }),
				token: "tok",
			})
		).content[0]?.text;
		expect(empty).toContain("No contact matched");
		expect(empty).not.toContain("no contact has it as a role");
		expect(
			empty?.match(
				/Only the first 50000 cards of the address books were searched/gu
			)
		).toHaveLength(1);
		const byRole = (
			await searchContacts(deps, {
				args: args({ query: "my person 1" }),
				token: "tok",
			})
		).content[0]?.text;
		expect(byRole).toContain("of at least");
		expect(byRole).toContain(
			'None of the people above has "person 1" as a role'
		);
		expect(byRole?.match(/Only the first 50000 cards/gu)).toHaveLength(1);
	});

	test("a book of exactly the cap, or smaller, gets no cap note", async () => {
		for (const n of [3, 50_000]) {
			const text = (
				await searchContacts(makeDeps(fillerCards(n)), {
					args: args({ query: "person 2" }),
					token: "tok",
				})
			).content[0]?.text;
			expect(text).toContain("person(s) matched");
			expect(text).not.toContain("were searched");
		}
	});
});
