import { describe, expect, test } from "vitest";

import {
	type ContactCard,
	type ContactCardDraft,
	ContactUidTakenError,
} from "../jmap/index.ts";

import { cardAddresses, collectedNoteEntry, readCollected } from "./card.ts";
import {
	COLLECTED_BOOK_NAME,
	COLLECTED_NOTE_KEY,
	COLLECTED_PATCH_PATH,
} from "./constants.ts";
import { mergeCards } from "./merge.ts";
import { type CollectionDeps, collectContacts } from "./upsert.ts";

const CTX = {
	accountId: "acct",
	apiUrl: "https://mail.example.com/jmap/",
	authorization: "Basic x",
};

interface Captured {
	bookCreates: string[];
	cardCreates: ContactCardDraft[];
	cardDestroys: string[];
	cardUpdates: { cardId: string; patch: Record<string, unknown> }[];
	queries: unknown[];
}

const makeDeps = (
	captured: Captured,
	opts: { books?: { id: string; name: string }[]; cards?: ContactCard[] } = {}
): CollectionDeps => ({
	addressBookCreate: (p) => {
		captured.bookCreates.push(p.name);
		return Promise.resolve("book-new");
	},
	addressBookList: () => Promise.resolve(opts.books ?? []),
	contactCardCreate: (p) => {
		captured.cardCreates.push(p.card);
		return Promise.resolve(`card-${captured.cardCreates.length}`);
	},
	contactCardDestroy: (p) => {
		captured.cardDestroys.push(p.cardId);
		return Promise.resolve();
	},
	contactCardGet: () => Promise.resolve(opts.cards ?? []),
	contactCardQuery: (p) => {
		captured.queries.push(p.filter);
		return Promise.resolve((opts.cards ?? []).map((c) => c.id));
	},
	contactCardUpdate: (p) => {
		captured.cardUpdates.push({ cardId: p.cardId, patch: p.patch });
		return Promise.resolve();
	},
});

const observation = {
	address: "robin@northwind.example",
	channel: "email" as const,
	confidence: "strong" as const,
	date: "2026-07-20T12:00:00Z",
	direction: "incoming" as const,
	name: "Robin Fairweather",
	recordId: "m1",
};

describe("collectContacts", () => {
	test("provisions the collected book lazily and creates the card there", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		await collectContacts(makeDeps(captured), CTX, {
			observations: [observation],
			relays: [],
		});
		expect(captured.bookCreates).toEqual([COLLECTED_BOOK_NAME]);
		expect(captured.cardCreates).toHaveLength(1);
		expect(captured.cardCreates[0]?.addressBookIds).toEqual({
			"book-new": true,
		});
	});

	test("reuses an existing collected book and queries by address, collected uid and name", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		await collectContacts(
			makeDeps(captured, {
				books: [{ id: "book-c", name: COLLECTED_BOOK_NAME }],
			}),
			CTX,
			{
				observations: [observation],
				relays: [],
			}
		);
		expect(captured.bookCreates).toEqual([]);
		expect(captured.queries).toEqual([
			{
				conditions: [
					{ email: "robin@northwind.example" },
					{ uid: "urn:langmail:collected:robin@northwind.example" },
					{ name: "Robin Fairweather" },
				],
				operator: "OR",
			},
		]);
		expect(captured.cardCreates[0]?.addressBookIds).toEqual({ "book-c": true });
	});

	test("updates an existing card instead of creating a duplicate", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		const existing = {
			addressBookIds: { "book-personal": true },
			emails: { e0: { address: "robin@northwind.example" } },
			id: "card-9",
			name: { full: "Robin Fairweather" },
		} as ContactCard;
		await collectContacts(
			makeDeps(captured, {
				books: [{ id: "book-c", name: COLLECTED_BOOK_NAME }],
				cards: [existing],
			}),
			CTX,
			{ observations: [observation], relays: [] }
		);
		expect(captured.cardCreates).toEqual([]);
		expect(captured.cardUpdates).toHaveLength(1);
		expect(captured.cardUpdates[0]?.cardId).toBe("card-9");
		// The fixture card carries no notes, so the payload arrives as a full
		// top-level set rather than the scoped path (see foldObservations).
		expect(captured.cardUpdates[0]?.patch.notes).toBeDefined();
		expect(
			captured.cardUpdates[0]?.patch[COLLECTED_PATCH_PATH]
		).toBeUndefined();
	});

	test("pages the candidate query until exhausted instead of truncating", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		const pageSize = 100;
		const allIds = Array.from({ length: pageSize + 3 }, (_, i) => `card-${i}`);
		const deps = makeDeps(captured, {
			books: [{ id: "book-c", name: COLLECTED_BOOK_NAME }],
		});
		deps.contactCardQuery = (p) => {
			captured.queries.push({ limit: p.limit, position: p.position });
			const start = p.position ?? 0;
			return Promise.resolve(
				allIds.slice(start, start + (p.limit ?? pageSize))
			);
		};
		const fetched: string[][] = [];
		deps.contactCardGet = (p) => {
			fetched.push(p.ids);
			return Promise.resolve([]);
		};
		await collectContacts(deps, CTX, {
			observations: [observation],
			relays: [],
		});
		expect(captured.queries).toEqual([
			{ limit: pageSize, position: 0 },
			{ limit: pageSize, position: pageSize },
		]);
		expect(fetched[0]).toHaveLength(pageSize + 3);
	});

	// Two writers (the poller's batch and a calendar write-through) both miss a
	// new person and both create the collected card; Stalwart rejects the
	// second for its uid. That person is collected already, so the rest of the
	// batch goes on.
	test("skips a card whose uid a concurrent writer took, and collects the rest", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		const deps = makeDeps(captured);
		deps.contactCardCreate = (p) => {
			captured.cardCreates.push(p.card);
			return captured.cardCreates.length === 1
				? Promise.reject(new ContactUidTakenError())
				: Promise.resolve(`card-${captured.cardCreates.length}`);
		};
		await collectContacts(deps, CTX, {
			observations: [
				observation,
				{ ...observation, address: "sam@northwind.example", name: "Sam Lowe" },
			],
			relays: [],
		});
		expect(captured.cardCreates).toHaveLength(2);
	});

	test("still fails the batch on any other create error", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		const deps = makeDeps(captured);
		deps.contactCardCreate = () => Promise.reject(new Error("socket closed"));
		await expect(
			collectContacts(deps, CTX, { observations: [observation], relays: [] })
		).rejects.toThrow("socket closed");
	});

	describe("a personal card duplicating a Collected card", () => {
		const books = [{ id: "book-c", name: COLLECTED_BOOK_NAME }];
		const collectedCard = {
			addressBookIds: { "book-c": true },
			emails: { e0: { address: "robin@northwind.example" } },
			id: "card-collected",
			name: { full: "Robin Fairweather" },
			uid: "urn:langmail:collected:robin@northwind.example",
		} as ContactCard;
		const personalCard = {
			addressBookIds: { "book-personal": true },
			emails: { e0: { address: "robin@northwind.example" } },
			id: "card-personal",
			name: { full: "Robin Fairweather" },
		} as ContactCard;

		test("updates the personal card, then destroys the Collected card", async () => {
			const captured: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			const order: string[] = [];
			const deps = makeDeps(captured, {
				books,
				cards: [collectedCard, personalCard],
			});
			deps.contactCardUpdate = (p) => {
				order.push(`update ${p.cardId}`);
				return Promise.resolve();
			};
			deps.contactCardDestroy = (p) => {
				order.push(`destroy ${p.cardId}`);
				return Promise.resolve();
			};
			await collectContacts(deps, CTX, {
				observations: [observation],
				relays: [],
			});
			expect(order).toEqual(["update card-personal", "destroy card-collected"]);
		});

		test("a failed update of the personal card leaves both cards", async () => {
			const captured: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			const deps = makeDeps(captured, {
				books,
				cards: [collectedCard, personalCard],
			});
			deps.contactCardUpdate = () => Promise.reject(new Error("stateMismatch"));
			await expect(
				collectContacts(deps, CTX, { observations: [observation], relays: [] })
			).rejects.toThrow("stateMismatch");
			expect(captured.cardDestroys).toEqual([]);
		});

		test("also fetches the owners of the Collected card's other addresses", async () => {
			const captured: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			const twin = {
				...collectedCard,
				emails: {
					...collectedCard.emails,
					e1: { address: "robin@home.example" },
				},
			};
			const other = {
				...personalCard,
				emails: { e0: { address: "robin@home.example" } },
				id: "card-other",
			};
			const deps = makeDeps(captured, { books, cards: [twin, personalCard] });
			deps.contactCardQuery = (p) => {
				captured.queries.push(p.filter);
				return Promise.resolve(
					captured.queries.length === 1
						? [twin.id, personalCard.id]
						: [other.id]
				);
			};
			deps.contactCardGet = (p) =>
				Promise.resolve(
					[twin, personalCard, other].filter((c) =>
						p.ids.includes(c.id)
					) as ContactCard[]
				);
			await collectContacts(deps, CTX, {
				observations: [observation],
				relays: [],
			});
			expect(captured.queries[1]).toEqual({
				conditions: [{ email: "robin@home.example" }],
				operator: "OR",
			});
			// card-other already holds the second address, so the Collected card
			// stays rather than splitting its history between two cards.
			expect(captured.cardDestroys).toEqual([]);
		});

		test("a failed destroy does not cost the rest of the batch its updates", async () => {
			const captured: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			const sam = {
				addressBookIds: { "book-personal": true },
				emails: { e0: { address: "sam@northwind.example" } },
				id: "card-sam",
				name: { full: "Sam Lowe" },
			} as ContactCard;
			const deps = makeDeps(captured, {
				books,
				cards: [collectedCard, personalCard, sam],
			});
			deps.contactCardDestroy = () => Promise.reject(new Error("rateLimit"));
			await collectContacts(deps, CTX, {
				observations: [
					observation,
					{
						...observation,
						address: "sam@northwind.example",
						name: "Sam Lowe",
					},
				],
				relays: [],
			});
			expect(captured.cardUpdates.map((u) => u.cardId).sort()).toEqual([
				"card-personal",
				"card-sam",
			]);
		});

		// Index lag: the `email` condition misses the freshly imported personal
		// card, while the `uid` condition still finds the Collected one. The
		// observation lands on the Collected card; nothing new is created, and
		// the next batch that sees both cards merges them.
		test("when the email lookup misses the personal card, no second Collected card appears", async () => {
			const captured: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			await collectContacts(
				makeDeps(captured, { books, cards: [collectedCard] }),
				CTX,
				{
					observations: [observation],
					relays: [],
				}
			);
			expect(captured.cardCreates).toEqual([]);
			expect(captured.cardDestroys).toEqual([]);
			expect(captured.cardUpdates.map((u) => u.cardId)).toEqual([
				"card-collected",
			]);
		});
	});

	test("does nothing without observations", async () => {
		const captured: Captured = {
			bookCreates: [],
			cardCreates: [],
			cardDestroys: [],
			cardUpdates: [],
			queries: [],
		};
		await collectContacts(makeDeps(captured), CTX, {
			observations: [],
			relays: [{ address: "noreply@x.example", recordId: "m1" }],
		});
		expect(captured.queries).toEqual([]);
		expect(captured.bookCreates).toEqual([]);
	});

	// merge_contacts leaves the merged addresses on the kept card and nothing
	// else behind. These fakes answer each query condition the way Stalwart
	// does — `email` by exact address from the index, `uid` from the store —
	// so the kept card is found by its new address alone: the destroyed card
	// took the merged address's collected uid with it.
	describe("after merge_contacts", () => {
		const MERGED = "gym@booking.example";
		const books = [{ id: "book-c", name: COLLECTED_BOOK_NAME }];

		const ext = (address: string, recordId: string) =>
			collectedNoteEntry({
				addresses: {
					[address]: {
						confidence: "strong",
						count: 1,
						firstSeen: "2026-10-01T08:00:00Z",
						lastSeen: "2026-10-01T08:00:00Z",
					},
				},
				interactions: [
					{
						channel: "email",
						date: "2026-10-01T08:00:00Z",
						direction: "incoming",
						recordId,
					},
				],
				source: "derived",
			});

		const keptBefore = (book: string): ContactCard => ({
			addressBookIds: { [book]: true },
			emails: { e0: { address: "hello@gym.example" } },
			id: "card-kept",
			name: { full: "Example Gym" },
			notes: { [COLLECTED_NOTE_KEY]: ext("hello@gym.example", "m-member") },
			uid: "urn:langmail:collected:hello@gym.example",
		});

		const mergedAway: ContactCard = {
			addressBookIds: { "book-c": true },
			emails: { e0: { address: MERGED } },
			id: "card-merged",
			name: { full: "Example Gym Booking" },
			notes: { [COLLECTED_NOTE_KEY]: ext(MERGED, "m-booking") },
			uid: `urn:langmail:collected:${MERGED}`,
		};

		// The kept card as the server stores it after the merge's patch.
		const keptAfter = (book: string): ContactCard => {
			const before = keptBefore(book);
			const result = mergeCards(before, [mergedAway]);
			if ("error" in result) {
				throw new Error(result.error);
			}
			const { [`notes/${COLLECTED_NOTE_KEY}`]: collected, ...rest } =
				result.patch;
			return {
				...before,
				...rest,
				notes: { ...before.notes, [COLLECTED_NOTE_KEY]: collected },
			} as ContactCard;
		};

		const indexedDeps = (
			captured: Captured,
			cards: ContactCard[],
			indexed: ContactCard[] = cards
		): CollectionDeps => ({
			...makeDeps(captured, { books }),
			contactCardGet: (p) =>
				Promise.resolve(cards.filter((c) => p.ids.includes(c.id))),
			contactCardQuery: (p) => {
				captured.queries.push(p.filter);
				const conditions = (
					p.filter as { conditions: { email?: string; uid?: string }[] }
				).conditions;
				return Promise.resolve(
					cards
						.filter((c) =>
							conditions.some(
								(cond) =>
									(cond.uid !== undefined && c.uid === cond.uid) ||
									(cond.email !== undefined &&
										indexed.includes(c) &&
										cardAddresses(c).includes(cond.email))
							)
						)
						.map((c) => c.id)
				);
			},
		});

		const sighting = {
			...observation,
			address: MERGED,
			name: "Example Gym Booking",
			recordId: "m-new",
		};

		for (const [where, book] of [
			["a personal book", "book-personal"],
			["the Collected book", "book-c"],
		] as const) {
			test(`a message from a merged address updates the kept card in ${where}`, async () => {
				const captured: Captured = {
					bookCreates: [],
					cardCreates: [],
					cardDestroys: [],
					cardUpdates: [],
					queries: [],
				};
				await collectContacts(indexedDeps(captured, [keptAfter(book)]), CTX, {
					observations: [sighting],
					relays: [],
				});
				expect(captured.cardCreates).toEqual([]);
				expect(captured.cardUpdates.map((u) => u.cardId)).toEqual([
					"card-kept",
				]);
				const patch = captured.cardUpdates[0]?.patch ?? {};
				const updated = readCollected({
					...keptAfter(book),
					notes: { [COLLECTED_NOTE_KEY]: patch[COLLECTED_PATCH_PATH] },
				} as ContactCard);
				expect(updated.addresses[MERGED]?.count).toBe(2);
				expect(updated.interactions.map((t) => t.recordId)).toContain("m-new");
			});
		}

		// In the moment before the index catches up with the merge, a sighting
		// mints a fresh Collected card. The next batch, which finds both cards,
		// folds it back into the kept card, also when that one is a Collected card.
		test("a card minted during index lag is folded back into a kept Collected card", async () => {
			const kept = keptAfter("book-c");
			const lagged: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			await collectContacts(indexedDeps(lagged, [kept], []), CTX, {
				observations: [sighting],
				relays: [],
			});
			expect(lagged.cardCreates).toHaveLength(1);

			const fresh = {
				...(lagged.cardCreates[0] as ContactCardDraft),
				id: "card-fresh",
			} as ContactCard;
			const captured: Captured = {
				bookCreates: [],
				cardCreates: [],
				cardDestroys: [],
				cardUpdates: [],
				queries: [],
			};
			await collectContacts(indexedDeps(captured, [kept, fresh]), CTX, {
				observations: [{ ...sighting, recordId: "m-later" }],
				relays: [],
			});
			expect(captured.cardCreates).toEqual([]);
			expect(captured.cardUpdates.map((u) => u.cardId)).toEqual(["card-kept"]);
			expect(captured.cardDestroys).toEqual(["card-fresh"]);
			const patch = captured.cardUpdates[0]?.patch ?? {};
			const history = readCollected({
				...kept,
				notes: { [COLLECTED_NOTE_KEY]: patch[COLLECTED_PATCH_PATH] },
			} as ContactCard);
			expect(history.absorbed).toEqual(["card-merged", "card-fresh"]);
			expect(history.addresses[MERGED]?.count).toBe(3);
		});
	});
});
