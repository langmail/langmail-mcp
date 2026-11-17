import { describe, expect, test } from "vitest";

import type { ContactCard } from "../jmap/index.ts";

import { collectedNoteEntry } from "./card.ts";
import {
	COLLECTED_NOTE_KEY,
	COLLECTED_PATCH_PATH,
	COLLECTED_PROPERTY,
	INTERACTION_LOG_SIZE,
} from "./constants.ts";
import { foldObservations } from "./fold.ts";
import type { CollectedExtension, Observation } from "./types.ts";

const BOOK = "book-collected";

const obs = (over: Partial<Observation> = {}): Observation => ({
	address: "robin@northwind.example",
	channel: "email",
	confidence: "strong",
	date: "2026-07-20T12:00:00Z",
	direction: "incoming",
	name: "Robin Fairweather",
	recordId: "m1",
	...over,
});

// Extension payload off either a create draft (nested in the machine note
// entry) or an update patch (scoped patch path).
const readExt = (holder: Record<string, unknown>): CollectedExtension => {
	const entry =
		(holder[COLLECTED_PATCH_PATH] as Record<string, unknown> | undefined) ??
		(holder.notes as Record<string, Record<string, unknown>> | undefined)?.[
			COLLECTED_NOTE_KEY
		];
	return entry?.[COLLECTED_PROPERTY] as CollectedExtension;
};

const existingCard = (over: Partial<ContactCard> = {}): ContactCard => ({
	addressBookIds: { "book-personal": true },
	emails: {
		e0: { address: "robin@northwind.example", contexts: { work: true } },
	},
	id: "card-1",
	name: { full: "Robin Fairweather" },
	...over,
});

describe("foldObservations — creation", () => {
	test("a new person becomes one card in the collected book with graded extension data", () => {
		const { creates, updates } = foldObservations(
			{ cards: [], collectedBookId: BOOK },
			[obs()]
		);
		expect(updates).toEqual([]);
		expect(creates).toHaveLength(1);
		const card = creates[0];
		expect(card?.addressBookIds).toEqual({ [BOOK]: true });
		expect(card?.name).toEqual({ full: "Robin Fairweather" });
		expect(card?.version).toBe("1.0");
		expect(card?.uid).toBe("urn:langmail:collected:robin@northwind.example");
		expect(Object.values(card?.emails ?? {})).toEqual([
			{ address: "robin@northwind.example", contexts: { work: true } },
		]);
		const ext = readExt(card as unknown as Record<string, unknown>);
		expect(ext.addresses["robin@northwind.example"]).toEqual({
			confidence: "strong",
			count: 1,
			firstSeen: "2026-07-20T12:00:00Z",
			lastSeen: "2026-07-20T12:00:00Z",
		});
		expect(ext.interactions).toEqual([
			{
				channel: "email",
				date: "2026-07-20T12:00:00Z",
				direction: "incoming",
				recordId: "m1",
			},
		]);
	});

	test("the Robin case: a created lunch event yields a confirmed work address", () => {
		const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, [
			obs({
				channel: "calendar",
				confidence: "confirmed",
				date: "2026-07-28T12:00:00Z",
				direction: "outgoing",
				recordId: "evt-lunch@example.com",
			}),
		]);
		const ext = readExt(creates[0] as unknown as Record<string, unknown>);
		expect(ext.addresses["robin@northwind.example"]?.confidence).toBe(
			"confirmed"
		);
		expect(Object.values(creates[0]?.emails ?? {})[0]?.contexts).toEqual({
			work: true,
		});
	});

	test("two same-first-name people without co-occurrence stay unmerged", () => {
		const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, [
			obs({
				address: "robin@northwind.example",
				name: "Robin",
				recordId: "m1",
			}),
			obs({
				address: "robin@othercorp.example",
				name: "Robin",
				recordId: "m2",
			}),
		]);
		expect(creates).toHaveLength(2);
	});

	test("an exact-name match with co-occurrence joins the address to the existing person", () => {
		const { creates, updates } = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[
				obs({ address: "robin@northwind.example", recordId: "m9" }),
				obs({
					address: "example-robin@gmail.com",
					name: "robin  fairweather",
					recordId: "m9",
				}),
			]
		);
		expect(creates).toEqual([]);
		expect(updates).toHaveLength(1);
		const patch = updates[0]?.patch ?? {};
		const emails = Object.values(
			(patch.emails ?? {}) as Record<string, { address: string }>
		);
		expect(emails.map((e) => e.address).sort()).toEqual([
			"example-robin@gmail.com",
			"robin@northwind.example",
		]);
		const ext = readExt(patch);
		expect(ext.addresses["example-robin@gmail.com"]?.confidence).toBe("strong");
	});

	test("a name match without co-occurrence does NOT join — separate card instead", () => {
		const { creates, updates } = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[
				obs({
					address: "example-robin@gmail.com",
					name: "Robin Fairweather",
					recordId: "m-other",
				}),
			]
		);
		expect(updates).toEqual([]);
		expect(creates).toHaveLength(1);
	});
});

describe("foldObservations — updates and ownership", () => {
	test("sent-mail confirmation upgrades a strong address, never downgrades a confirmed one", () => {
		const card = existingCard({
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry({
					addresses: {
						"robin@northwind.example": {
							confidence: "strong",
							count: 2,
							firstSeen: "2026-05-01T09:00:00Z",
							lastSeen: "2026-06-01T09:00:00Z",
						},
					},
					interactions: [],
				}),
			},
		});
		const upgraded = foldObservations(
			{ cards: [card], collectedBookId: BOOK },
			[
				obs({
					confidence: "confirmed",
					date: "2026-07-01T09:00:00Z",
					direction: "outgoing",
					recordId: "m-sent",
				}),
			]
		);
		const ext = readExt(upgraded.updates[0]?.patch ?? {});
		expect(ext.addresses["robin@northwind.example"]?.confidence).toBe(
			"confirmed"
		);
		expect(ext.addresses["robin@northwind.example"]?.count).toBe(3);
		expect(ext.addresses["robin@northwind.example"]?.lastSeen).toBe(
			"2026-07-01T09:00:00Z"
		);

		const downgraded = foldObservations(
			{
				cards: [
					{ ...card, notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(ext) } },
				],
				collectedBookId: BOOK,
			},
			[obs({ confidence: "weak", recordId: "m-cc" })]
		);
		const ext2 = readExt(downgraded.updates[0]?.patch ?? {});
		expect(ext2.addresses["robin@northwind.example"]?.confidence).toBe(
			"confirmed"
		);
	});

	test("re-folding a record already in the interaction log does not double-count", () => {
		const first = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[obs()]
		);
		const patch = first.updates[0]?.patch ?? {};
		const afterFirst = {
			...existingCard(),
			notes: patch.notes ?? {
				[COLLECTED_NOTE_KEY]: patch[COLLECTED_PATCH_PATH],
			},
			...(patch.emails ? { emails: patch.emails } : {}),
		} as ContactCard;
		const second = foldObservations(
			{ cards: [afterFirst], collectedBookId: BOOK },
			[obs()]
		);
		// The observation is absorbed without a counter or log change.
		if (second.updates.length > 0) {
			const ext = readExt(second.updates[0]?.patch ?? {});
			expect(ext.addresses["robin@northwind.example"]?.count).toBe(1);
			expect(ext.interactions).toHaveLength(1);
		}
		expect(second.creates).toEqual([]);
	});

	test("a personal-book card gains extension data in place — no duplicate in the collected book", () => {
		const { creates, updates } = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[obs()]
		);
		expect(creates).toEqual([]);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.cardId).toBe("card-1");
		// addressBookIds untouched: the card stays in the personal book.
		expect(updates[0]?.patch.addressBookIds).toBeUndefined();
	});

	test("a card without notes gets a full top-level notes set (RFC 8620 rejects the scoped path)", () => {
		const { updates } = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[obs()]
		);
		const patch = updates[0]?.patch ?? {};
		expect(patch[COLLECTED_PATCH_PATH]).toBeUndefined();
		expect(
			(patch.notes as Record<string, unknown>)[COLLECTED_NOTE_KEY]
		).toBeDefined();
	});

	test("a card with user notes gets the scoped path so those notes survive", () => {
		const withUserNote = existingCard({
			notes: { mine: { note: "met at the conference" } },
		} as Partial<ContactCard>);
		const { updates } = foldObservations(
			{ cards: [withUserNote], collectedBookId: BOOK },
			[obs()]
		);
		const patch = updates[0]?.patch ?? {};
		expect(patch.notes).toBeUndefined();
		expect(patch[COLLECTED_PATCH_PATH]).toBeDefined();
	});

	test("fills a blank display name but never overwrites a user-set one", () => {
		const nameless = existingCard({ name: undefined });
		const filled = foldObservations(
			{ cards: [nameless], collectedBookId: BOOK },
			[obs()]
		);
		expect(filled.updates[0]?.patch.name).toEqual({
			full: "Robin Fairweather",
		});

		const named = existingCard({ name: { full: "Robin M. (edited)" } });
		const kept = foldObservations({ cards: [named], collectedBookId: BOOK }, [
			obs(),
		]);
		expect(kept.updates[0]?.patch.name).toBeUndefined();
	});

	test("caps the interaction log and keeps it newest-first", () => {
		const observations = Array.from(
			{ length: INTERACTION_LOG_SIZE + 3 },
			(_, i) =>
				obs({
					date: `2026-07-${String(i + 1).padStart(2, "0")}T09:00:00Z`,
					recordId: `m${i}`,
				})
		);
		const { creates } = foldObservations(
			{ cards: [], collectedBookId: BOOK },
			observations
		);
		const ext = readExt(creates[0] as unknown as Record<string, unknown>);
		expect(ext.interactions).toHaveLength(INTERACTION_LOG_SIZE);
		expect(ext.interactions[0]?.recordId).toBe(`m${INTERACTION_LOG_SIZE + 2}`);
		expect(ext.addresses["robin@northwind.example"]?.count).toBe(
			INTERACTION_LOG_SIZE + 3
		);
		expect(ext.addresses["robin@northwind.example"]?.firstSeen).toBe(
			"2026-07-01T09:00:00Z"
		);
	});

	test("records a relay observed alongside a known person on that person", () => {
		const { updates } = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[obs({ recordId: "m-digest" })],
			[
				{
					address: "example-messaging-digest-noreply@linkedin.com",
					recordId: "m-digest",
				},
			]
		);
		const ext = readExt(updates[0]?.patch ?? {});
		expect(ext.relays).toEqual([
			"example-messaging-digest-noreply@linkedin.com",
		]);
	});

	test("a relay with no co-occurring person touches nothing", () => {
		const { creates, updates } = foldObservations(
			{ cards: [existingCard()], collectedBookId: BOOK },
			[],
			[
				{
					address: "example-messaging-digest-noreply@linkedin.com",
					recordId: "m-solo",
				},
			]
		);
		expect(creates).toEqual([]);
		expect(updates).toEqual([]);
	});
});

describe("foldObservations — provenance", () => {
	test("a card the fold creates is stamped derived", () => {
		const { creates } = foldObservations({ cards: [], collectedBookId: BOOK }, [
			obs(),
		]);
		expect(
			readExt(creates[0] as unknown as Record<string, unknown>).source
		).toBe("derived");
	});

	test("an authored stamp survives later collection — derivation never relabels the card", () => {
		const card = existingCard({
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry({
					addresses: {},
					interactions: [],
					source: "authored",
				}),
			},
		});
		const { updates } = foldObservations(
			{ cards: [card], collectedBookId: BOOK },
			[obs()]
		);
		expect(readExt(updates[0]?.patch ?? {}).source).toBe("authored");
	});

	test("a role the user named is never written or overwritten by collection", () => {
		const card = existingCard({
			titles: { r0: { kind: "role", name: "lawyer" } },
		});
		const { creates, updates } = foldObservations(
			{ cards: [card], collectedBookId: BOOK },
			[
				obs(),
				obs({ address: "kim@fairweather-law.example", name: "Kim Lawyer" }),
			]
		);
		expect(updates[0]?.patch.titles).toBeUndefined();
		expect(creates.every((c) => c.titles === undefined)).toBe(true);
	});

	test("an authored name is never overwritten by an observed one", () => {
		const card = existingCard({ name: { full: "Robin Fairweather-Ng" } });
		const { updates } = foldObservations(
			{ cards: [card], collectedBookId: BOOK },
			[obs({ name: "Robin Fairweather" })]
		);
		expect(updates[0]?.patch.name).toBeUndefined();
	});
});

describe("foldObservations — a personal card duplicating a Collected one", () => {
	// The pair a contact import leaves behind: a personal card with the
	// details and no history, and the older Collected card with all of it.
	const collectedTwin = (over: Partial<ContactCard> = {}): ContactCard =>
		existingCard({
			addressBookIds: { [BOOK]: true },
			emails: {
				e0: { address: "robin@northwind.example", contexts: { work: true } },
				e1: {
					address: "robin@fairweather.example",
					contexts: { private: true },
				},
			},
			id: "card-collected",
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry({
					addresses: {
						"robin@fairweather.example": {
							confidence: "weak",
							count: 2,
							firstSeen: "2026-02-01T09:00:00Z",
							lastSeen: "2026-03-01T09:00:00Z",
						},
						"robin@northwind.example": {
							confidence: "confirmed",
							count: 5,
							firstSeen: "2026-01-10T09:00:00Z",
							lastSeen: "2026-05-01T09:00:00Z",
						},
					},
					interactions: [
						{
							channel: "email",
							date: "2026-05-01T09:00:00Z",
							direction: "incoming",
							recordId: "c1",
						},
						{
							channel: "calendar",
							date: "2026-04-01T09:00:00Z",
							direction: "outgoing",
							recordId: "c2",
						},
					],
					relays: ["example-messaging-digest-noreply@linkedin.com"],
					source: "derived",
				}),
			},
			uid: "urn:langmail:collected:robin@northwind.example",
			...over,
		});

	const personalTwin = (over: Partial<ContactCard> = {}): ContactCard =>
		existingCard({
			id: "card-personal",
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry({
					addresses: {
						"robin@northwind.example": {
							confidence: "strong",
							count: 3,
							firstSeen: "2026-03-01T09:00:00Z",
							lastSeen: "2026-06-01T09:00:00Z",
						},
					},
					interactions: [
						{
							channel: "email",
							date: "2026-06-01T09:00:00Z",
							direction: "outgoing",
							recordId: "p1",
						},
						// Logged on both cards: the log keeps it once. Counts carry no
						// record ids, so they are summed as stored.
						{
							channel: "email",
							date: "2026-05-01T09:00:00Z",
							direction: "incoming",
							recordId: "c1",
						},
					],
					relays: ["notifications@relay.example"],
				}),
			},
			phones: { p0: { contexts: { private: true }, number: "+49 30 1234567" } },
			...over,
		});

	const fold = (
		cards: ContactCard[],
		observations: Observation[] = [obs({ date: "2026-07-20T12:00:00Z" })]
	) => foldObservations({ cards, collectedBookId: BOOK }, observations, []);

	test("applies the observation to the personal card and destroys the Collected card", () => {
		// Collected card first, as the older card sorts in the candidate query.
		const { creates, updates } = fold([collectedTwin(), personalTwin()]);
		expect(creates).toEqual([]);
		expect(updates.map((u) => [u.cardId, u.absorbs])).toEqual([
			["card-personal", ["card-collected"]],
		]);
	});

	test("merges each rule: counts summed, earliest first-seen, latest last-seen, highest confidence", () => {
		const { updates } = fold([collectedTwin(), personalTwin()]);
		const ext = readExt(updates[0]?.patch ?? {});
		expect(ext.addresses["robin@northwind.example"]).toEqual({
			confidence: "confirmed",
			// 3 personal + 5 collected + this batch's observation.
			count: 9,
			firstSeen: "2026-01-10T09:00:00Z",
			lastSeen: "2026-07-20T12:00:00Z",
		});
		// An address only the Collected card had arrives as it was.
		expect(ext.addresses["robin@fairweather.example"]).toEqual({
			confidence: "weak",
			count: 2,
			firstSeen: "2026-02-01T09:00:00Z",
			lastSeen: "2026-03-01T09:00:00Z",
		});
	});

	test("unions the interaction log and the relays, and keeps the personal source", () => {
		const { updates } = fold([collectedTwin(), personalTwin()]);
		const ext = readExt(updates[0]?.patch ?? {});
		expect(ext.interactions.map((t) => t.recordId)).toEqual([
			"m1",
			"p1",
			"c1",
			"c2",
		]);
		expect(ext.relays).toEqual([
			"notifications@relay.example",
			"example-messaging-digest-noreply@linkedin.com",
		]);
		// The personal card carried no marker: still imported, never derived.
		expect(ext.source).toBeUndefined();
	});

	test("the personal card gains the addresses only the Collected card held, and keeps its own fields", () => {
		const { updates } = fold([collectedTwin(), personalTwin()]);
		const patch = updates[0]?.patch ?? {};
		expect(
			Object.values(patch.emails as Record<string, { address: string }>)
		).toEqual([
			{ address: "robin@northwind.example", contexts: { work: true } },
			// Copied as the Collected card stored it, labels included.
			{ address: "robin@fairweather.example", contexts: { private: true } },
		]);
		expect(patch.phones).toBeUndefined();
		expect(patch.name).toBeUndefined();
	});

	test("takes the name when the personal card has none", () => {
		const { updates } = fold(
			[collectedTwin(), personalTwin({ name: null })],
			[obs({ name: undefined })]
		);
		expect(updates[0]?.patch.name).toEqual({ full: "Robin Fairweather" });
	});

	test("a personal card without notes receives the merged history as a full notes set", () => {
		const { updates } = fold([
			collectedTwin(),
			personalTwin({ notes: undefined }),
		]);
		const ext = readExt(updates[0]?.patch ?? {});
		expect(updates[0]?.patch[COLLECTED_PATCH_PATH]).toBeUndefined();
		expect(ext.addresses["robin@northwind.example"]?.count).toBe(6);
	});

	test("two personal cards and no Collected one: nothing is destroyed", () => {
		const { updates } = fold([
			personalTwin(),
			personalTwin({ id: "card-other" }),
		]);
		expect(updates.flatMap((u) => u.absorbs)).toEqual([]);
	});

	test("the Collected card alone (the personal card not yet indexed): updated in place, no new card", () => {
		const { creates, updates } = fold([collectedTwin()]);
		expect(creates).toEqual([]);
		expect(updates.map((u) => [u.cardId, u.absorbs])).toEqual([
			["card-collected", []],
		]);
	});

	test("a Collected card carrying details a person added stays, so nothing is lost", () => {
		for (const over of [
			{ phones: { p0: { number: "+49 30 7654321" } } },
			{ anniversaries: { b0: { date: { day: 1, month: 2 }, kind: "birth" } } },
			{ titles: { r0: { kind: "role", name: "lawyer" } } },
			{
				notes: {
					...collectedTwin().notes,
					"langmail-note": { note: "Met at the fair." },
				},
			},
			// Not in the typed ContactCard, but a CardDAV client can set it.
			{ nicknames: { k0: { name: "Robbie" } } },
		] as Partial<ContactCard>[]) {
			// The pair stays as it was before this change: the first holder takes
			// the observation, and nothing is destroyed.
			const { updates } = fold([collectedTwin(over), personalTwin()]);
			expect(updates.flatMap((u) => u.absorbs)).toEqual([]);
		}
	});

	test("a card in the Collected book and a personal book is not merged away", () => {
		const shared = collectedTwin({
			addressBookIds: { [BOOK]: true, "book-personal": true },
		});
		const { updates } = fold([shared, personalTwin()]);
		expect(updates.flatMap((u) => u.absorbs)).toEqual([]);
	});

	test("a retried destroy still moves an address added to the Collected card since", () => {
		const first = fold([collectedTwin(), personalTwin()]);
		const merged = personalTwin({
			emails: first.updates[0]?.patch.emails as ContactCard["emails"],
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry(
					readExt(first.updates[0]?.patch ?? {})
				),
			},
		});
		const edited = collectedTwin({
			emails: {
				...collectedTwin().emails,
				e2: { address: "robin@later.example" },
			},
		});
		const second = fold(
			[edited, merged],
			[obs({ date: "2026-07-21T12:00:00Z", recordId: "m2" })]
		);
		const emails = Object.values(
			second.updates[0]?.patch.emails as Record<string, { address: string }>
		);
		expect(emails.map((e) => e.address)).toContain("robin@later.example");
		expect(second.updates[0]?.absorbs).toEqual(["card-collected"]);
	});

	test("a merge whose destroy never landed is not summed a second time", () => {
		// First fold: the personal card's update lands, the destroy fails.
		const first = fold([collectedTwin(), personalTwin()]);
		const merged = personalTwin({
			emails: first.updates[0]?.patch.emails as ContactCard["emails"],
			notes: {
				[COLLECTED_NOTE_KEY]: collectedNoteEntry(
					readExt(first.updates[0]?.patch ?? {})
				),
			},
		});
		const second = fold(
			[collectedTwin(), merged],
			[obs({ date: "2026-07-21T12:00:00Z", recordId: "m2" })]
		);
		expect(second.updates.map((u) => [u.cardId, u.absorbs])).toEqual([
			["card-personal", ["card-collected"]],
		]);
		const ext = readExt(second.updates[0]?.patch ?? {});
		// 9 after the first merge, plus only this batch's observation.
		expect(ext.addresses["robin@northwind.example"]?.count).toBe(10);
		expect(ext.absorbed).toEqual(["card-collected"]);
	});

	test("two Collected duplicates both hand over their history", () => {
		const second = collectedTwin({
			id: "card-collected-2",
			uid: "urn:langmail:collected:robin@fairweather.example",
		});
		const { updates } = fold([collectedTwin(), second, personalTwin()]);
		expect(updates.map((u) => [u.cardId, u.absorbs])).toEqual([
			["card-personal", ["card-collected", "card-collected-2"]],
		]);
		// Both cards' sightings of the second address arrive: 2 + 2.
		expect(
			readExt(updates[0]?.patch ?? {}).addresses["robin@fairweather.example"]
				?.count
		).toBe(4);
	});

	test("a Collected card sharing an address with another personal card stays", () => {
		const other = personalTwin({
			emails: { e0: { address: "robin@fairweather.example" } },
			id: "card-other",
			notes: undefined,
		});
		const { updates } = fold([collectedTwin(), personalTwin(), other]);
		// Its history for that address belongs to neither card alone, so the pair
		// stays as it was before this change.
		expect(updates.flatMap((u) => u.absorbs)).toEqual([]);
	});
});
