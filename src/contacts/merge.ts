// Merging contact cards: the collected-history merge shared by the
// collection fold (a Collected card absorbed into a personal one) and by
// merge_contacts (cards an agent folds into one), plus the pure card merge
// behind merge_contacts. No IO: the caller reads the cards and applies the
// patch.
//
// "Remember the merge" needs no store of its own: the merged addresses
// become addresses of the kept card, and collection already finds the card
// holding an address, so a later sighting of any of them updates the kept
// card (there is no contact graph outside Stalwart).

import type {
	ContactCard,
	ContactCardEmail,
	ContactCardNote,
} from "../jmap/index.ts";

import { normalizeAddress } from "./address-class.ts";
import {
	collectedNoteEntry,
	nextKey,
	normalizeName,
	readCollected,
} from "./card.ts";
import {
	COLLECTED_NOTE_KEY,
	INTERACTION_LOG_SIZE,
	RELAY_LIST_SIZE,
} from "./constants.ts";
import {
	formatBirthday,
	formatCardAddress,
	readBirthday,
	readOrganization,
	readRoles,
	withBirthday,
	withRoles,
} from "./profile.ts";
import { bestAddress } from "./scoring.ts";
import type {
	CollectedAddress,
	CollectedExtension,
	Confidence,
} from "./types.ts";

const CONFIDENCE_RANK: Record<Confidence, number> = {
	confirmed: 2,
	strong: 1,
	weak: 0,
};

const time = (iso: string): number => new Date(iso).getTime();
const earlier = (a: string, b: string): string => (time(b) < time(a) ? b : a);
const later = (a: string, b: string): string => (time(b) > time(a) ? b : a);

const mergeEntry = (
	mine: CollectedAddress | undefined,
	theirs: CollectedAddress
): CollectedAddress =>
	mine
		? {
				confidence:
					CONFIDENCE_RANK[theirs.confidence] > CONFIDENCE_RANK[mine.confidence]
						? theirs.confidence
						: mine.confidence,
				count: mine.count + theirs.count,
				firstSeen: earlier(mine.firstSeen, theirs.firstSeen),
				lastSeen: later(mine.lastSeen, theirs.lastSeen),
			}
		: { ...theirs };

// Folds one card's collected history into another's: per address, counts
// summed, the earliest first-seen, the latest last-seen and the highest
// confidence; interaction log and relays unioned under their caps. `into`
// keeps its own `source`, so an imported card never turns derived by
// absorbing a collected one. The absorbed card's id is recorded, and a card
// already recorded is not summed again: a merge whose destroy never landed
// can be retried without doubling the counts.
export const mergeCollectedExtensions = (
	into: CollectedExtension,
	from: CollectedExtension,
	fromId: string
): CollectedExtension => {
	if (into.absorbed?.includes(fromId)) {
		return into;
	}
	const addresses = { ...into.addresses };
	for (const [address, entry] of Object.entries(from.addresses)) {
		addresses[address] = mergeEntry(addresses[address], entry);
	}
	const logged = new Set(into.interactions.map((t) => t.recordId));
	const interactions = [
		...into.interactions,
		...from.interactions.filter((t) => !logged.has(t.recordId)),
	]
		.sort((a, b) => time(b.date) - time(a.date))
		.slice(0, INTERACTION_LOG_SIZE);
	const relays = [
		...new Set([...(into.relays ?? []), ...(from.relays ?? [])]),
	].slice(0, RELAY_LIST_SIZE);
	return {
		...into,
		// The absorbed card's own absorbed ids come along, so a nested merge
		// (C into B, then B into A) still guards a retry of C into A.
		absorbed: [
			...new Set([...(into.absorbed ?? []), ...(from.absorbed ?? []), fromId]),
		],
		addresses,
		interactions,
		...(relays.length > 0 ? { relays } : {}),
	};
};

// --- preferred address -------------------------------------------------------

// RFC 9553 §1.5.4: 1 is the most preferred.
const PREFERRED = 1;

const prefOf = (entry: ContactCardEmail): number =>
	typeof entry.pref === "number" ? entry.pref : Number.POSITIVE_INFINITY;

// The address the card says mail should go to: the one carrying the lowest
// `pref`, else the best-graded one.
export const preferredAddress = (card: ContactCard): string | undefined => {
	const marked = Object.values(card.emails ?? {})
		.filter((e) => typeof e.pref === "number")
		.sort((a, b) => prefOf(a) - prefOf(b))[0];
	return marked
		? normalizeAddress(marked.address)
		: bestAddress(card, "any")?.address;
};

// The emails with `address` as the single preferred one: `pref` set on it,
// removed from every other entry. Undefined when the card does not hold it.
export const withPreferredEmail = (
	emails: Record<string, ContactCardEmail>,
	address: string
): Record<string, ContactCardEmail> | undefined => {
	const wanted = normalizeAddress(address);
	if (
		!Object.values(emails).some((e) => normalizeAddress(e.address) === wanted)
	) {
		return;
	}
	return Object.fromEntries(
		Object.entries(emails).map(([key, entry]) => {
			const { pref: _dropped, ...rest } = entry;
			return [
				key,
				normalizeAddress(entry.address) === wanted
					? { ...rest, pref: PREFERRED }
					: rest,
			];
		})
	);
};

// --- card merge --------------------------------------------------------------

// The JSContact properties the merge carries over or decides about. Anything
// else a merged card holds (a photo, a nickname, a title) goes with the
// card, and the merge reports it rather than dropping it silently.
const MERGED_PROPERTIES = new Set([
	"@type",
	"addressBookIds",
	"addresses",
	"anniversaries",
	"created",
	"emails",
	"id",
	"kind",
	"name",
	"notes",
	"organizations",
	"phones",
	"prodId",
	"titles",
	"uid",
	"updated",
	"version",
]);

export interface CardMerge {
	// What the merge could not carry over, one line each: a second birthday,
	// a name or organization the kept card's value replaced, properties the
	// merge does not model.
	conflicts: string[];
	// Addresses of the merged cards the kept card did not hold before: what
	// undoing the merge removes from it again.
	movedEmails: string[];
	// RFC 8620 §5.3 patch for the kept card.
	patch: Record<string, unknown>;
	// The address marked as preferred: `requested` by the caller, `unchanged`
	// (the kept card already marked it), or `pinned` (the kept card's best
	// address, marked now so the joining ones cannot outrank it).
	preferred?: { address: string; how: "pinned" | "requested" | "unchanged" };
}

const labelOf = (card: ContactCard): string =>
	`"${card.name?.full ?? Object.values(card.emails ?? {})[0]?.address ?? card.id}" (contact_id ${card.id})`;

// Formatting punctuation only: letters stay, so `… ext. 7` is not taken for
// the same number with a 7 appended.
const phoneKey = (number: string): string =>
	number.toLowerCase().replace(/[\s().\-/]/gu, "");

const noteText = (entry: ContactCardNote | undefined): string =>
	(entry?.note ?? "").trim();

const unionInto = <T>(
	target: Record<string, T>,
	source: Record<string, T> | null | undefined,
	prefix: string,
	identity: (value: T) => string
): boolean => {
	const present = new Set(Object.values(target).map(identity));
	let added = false;
	for (const value of Object.values(source ?? {})) {
		const id = identity(value);
		if (present.has(id)) {
			continue;
		}
		present.add(id);
		// A merged entry arrives without its own `pref`: the kept card's order
		// of preference stays as it was.
		const { pref: _dropped, ...rest } = value as T & { pref?: unknown };
		target[nextKey(target, prefix)] = rest as T;
		added = true;
	}
	return added;
};

const mergeEmails = (
	kept: ContactCard,
	merged: ContactCard[],
	preferredEmail: string | undefined
): {
	emails?: Record<string, ContactCardEmail>;
	error?: string;
	movedEmails: string[];
	preferred?: CardMerge["preferred"];
} => {
	const emails: Record<string, ContactCardEmail> = { ...(kept.emails ?? {}) };
	const before = new Set(
		Object.values(emails).map((e) => normalizeAddress(e.address))
	);
	for (const card of merged) {
		unionInto(emails, card.emails, "e", (e) => normalizeAddress(e.address));
	}
	const movedEmails = Object.values(emails)
		.map((e) => normalizeAddress(e.address))
		.filter((a) => !before.has(a));
	if (preferredEmail !== undefined) {
		const pinned = withPreferredEmail(emails, preferredEmail);
		if (!pinned) {
			const available = Object.values(emails)
				.map((e) => e.address)
				.join(", ");
			return {
				error: `${preferredEmail} is on none of these contacts. Their addresses: ${available}.`,
				movedEmails,
			};
		}
		return {
			emails: pinned,
			movedEmails,
			preferred: {
				address: normalizeAddress(preferredEmail),
				how: "requested",
			},
		};
	}
	const changed = movedEmails.length > 0 ? { emails } : {};
	// Without a choice from the caller, the kept card's preferred address stays
	// preferred. Both a joining address and the merged history (a higher grade
	// or a later sighting of an address the kept card already holds) could
	// otherwise outrank it, quietly changing who mail goes to.
	const current = preferredAddress(kept);
	if (current === undefined) {
		return { ...changed, movedEmails };
	}
	if (
		Object.values(kept.emails ?? {}).some((e) => typeof e.pref === "number")
	) {
		return {
			...changed,
			movedEmails,
			preferred: { address: current, how: "unchanged" },
		};
	}
	// A single address has nothing to be preferred over: no mark to write.
	if (Object.keys(emails).length < 2) {
		return { ...changed, movedEmails };
	}
	const pinned = withPreferredEmail(emails, current);
	return {
		...(pinned ? { emails: pinned } : changed),
		movedEmails,
		preferred: { address: current, how: "pinned" },
	};
};

const mergeName = (
	kept: ContactCard,
	merged: ContactCard[],
	conflicts: string[]
): Record<string, unknown> => {
	let name = kept.name?.full?.trim() || undefined;
	// The whole name object of the card that fills a blank one, so structured
	// parts a CardDAV client stored beside `full` come along.
	let filled: ContactCard["name"] | undefined;
	for (const card of merged) {
		const theirs = card.name?.full?.trim();
		if (!theirs) {
			continue;
		}
		if (name === undefined) {
			name = theirs;
			filled = card.name;
		} else if (normalizeName(theirs) !== normalizeName(name)) {
			conflicts.push(
				`name: kept "${name}", dropped "${theirs}" from ${labelOf(card)}`
			);
		}
	}
	return filled ? { name: filled } : {};
};

const mergeOrganization = (
	kept: ContactCard,
	merged: ContactCard[],
	conflicts: string[]
): Record<string, unknown> => {
	let organization = readOrganization(kept);
	let patch: Record<string, unknown> = {};
	for (const card of merged) {
		const theirs = readOrganization(card);
		if (!theirs) {
			continue;
		}
		if (organization === undefined) {
			organization = theirs;
			// The entry readOrganization shows, alone: any further ones are
			// reported with the card's other leftovers.
			const [key, entry] =
				Object.entries(card.organizations ?? {}).find(
					([, o]) => o.name === theirs
				) ?? [];
			patch = key && entry ? { organizations: { [key]: entry } } : {};
		} else if (theirs.toLowerCase() !== organization.toLowerCase()) {
			conflicts.push(
				`organization: kept "${organization}", dropped "${theirs}" from ${labelOf(card)}`
			);
		}
	}
	return patch;
};

const mergeBirthday = (
	kept: ContactCard,
	merged: ContactCard[],
	conflicts: string[]
): Record<string, unknown> => {
	let birthday = readBirthday(kept);
	let patch: Record<string, unknown> = {};
	for (const card of merged) {
		const theirs = readBirthday(card);
		if (!theirs) {
			continue;
		}
		if (birthday === undefined) {
			birthday = theirs;
			patch = { anniversaries: withBirthday(kept, theirs) };
		} else if (formatBirthday(theirs) !== formatBirthday(birthday)) {
			conflicts.push(
				`birthday: kept ${formatBirthday(birthday)}, dropped ${formatBirthday(theirs)} from ${labelOf(card)}`
			);
		}
	}
	return patch;
};

// Roles are what the user said each card's person is to them, so all of
// them carry over, without duplicates. A merged card's job titles do not:
// the kept card's own job title stands, and the others are reported.
const mergeRoles = (
	kept: ContactCard,
	merged: ContactCard[],
	conflicts: string[]
): Record<string, unknown> => {
	const before = readRoles(kept);
	const titles = withRoles(kept, merged.flatMap(readRoles), []);
	const jobTitle = (t: { name: string }): string => t.name.trim().toLowerCase();
	const keptJobs = new Set(
		Object.values(kept.titles ?? {})
			.filter((t) => t.kind !== "role")
			.map(jobTitle)
	);
	for (const card of merged) {
		if (
			Object.values(card.titles ?? {}).some(
				(t) => t.kind !== "role" && !keptJobs.has(jobTitle(t))
			)
		) {
			conflicts.push(`not carried over from ${labelOf(card)}: job titles`);
		}
	}
	return readRoles({ titles }).length > before.length ? { titles } : {};
};

// The kept card's note entries stay; each merged card's user notes join
// under fresh keys unless the same text is already there. The collected
// entry carries the merged history. Entries go through patch paths when the
// card has a `notes` property, so a note another client added in the
// meantime survives; a card without one takes a full set (RFC 8620 §5.3
// rejects a patch path whose parent is missing).
const mergeNotes = (
	kept: ContactCard,
	merged: ContactCard[]
): Record<string, unknown> => {
	const notes: Record<string, ContactCardNote> = { ...(kept.notes ?? {}) };
	const added: Record<string, ContactCardNote> = {};
	const present = new Set(
		Object.entries(notes)
			.filter(([key]) => key !== COLLECTED_NOTE_KEY)
			.map(([, entry]) => noteText(entry))
	);
	for (const card of merged) {
		for (const [key, entry] of Object.entries(card.notes ?? {})) {
			const text = noteText(entry);
			if (
				key === COLLECTED_NOTE_KEY ||
				text.length === 0 ||
				present.has(text)
			) {
				continue;
			}
			present.add(text);
			const fresh = nextKey(notes, "n");
			notes[fresh] = entry;
			added[fresh] = entry;
		}
	}
	// A card another merged card already absorbed (an earlier merge whose
	// destroy failed) goes last: by then that card has brought its id into
	// `absorbed`, so its history is not summed a second time, whatever order
	// the caller listed them in.
	const viaOthers = new Set(
		merged.flatMap((card) => readCollected(card).absorbed ?? [])
	);
	const ordered = [
		...merged.filter((c) => !viaOthers.has(c.id)),
		...merged.filter((c) => viaOthers.has(c.id)),
	];
	let ext = readCollected(kept);
	for (const card of ordered) {
		ext = mergeCollectedExtensions(ext, readCollected(card), card.id);
	}
	const collected = collectedNoteEntry(ext);
	if (typeof kept.notes !== "object" || kept.notes === null) {
		return { notes: { ...added, [COLLECTED_NOTE_KEY]: collected } };
	}
	return {
		...Object.fromEntries(
			Object.entries(added).map(([key, entry]) => [`notes/${key}`, entry])
		),
		[`notes/${COLLECTED_NOTE_KEY}`]: collected,
	};
};

const unmodeled = (
	kept: ContactCard,
	merged: ContactCard[],
	conflicts: string[]
): void => {
	for (const card of merged) {
		const extra = Object.entries(card)
			.filter(
				([key, value]) =>
					value !== null && value !== undefined && !MERGED_PROPERTIES.has(key)
			)
			.map(([key]) => key);
		const otherDates = Object.values(card.anniversaries ?? {}).filter(
			(a) => a.kind !== "birth"
		).length;
		if (otherDates > 0) {
			extra.push("anniversaries other than the birthday");
		}
		const kind = (card as { kind?: unknown }).kind;
		if (
			typeof kind === "string" &&
			kind !== ((kept as { kind?: unknown }).kind ?? "individual")
		) {
			extra.push(`kind "${kind}"`);
		}
		if (Object.keys(card.organizations ?? {}).length > 1) {
			extra.push("organizations after the first");
		}
		if (extra.length > 0) {
			conflicts.push(
				`not carried over from ${labelOf(card)}: ${extra.join(", ")}`
			);
		}
	}
};

// Folds `merged` into `kept`. The kept card's name, organization and
// birthday win; a blank one is filled from the first merged card holding
// it, and every other differing value is listed as a conflict. Emails,
// phones and postal addresses are joined without duplicates, notes
// combined, and the collected histories merged. The preferred address stays
// the kept card's unless `preferredEmail` names another.
export const mergeCards = (
	kept: ContactCard,
	merged: ContactCard[],
	preferredEmail?: string
): CardMerge | { error: string } => {
	const conflicts: string[] = [];
	const email = mergeEmails(kept, merged, preferredEmail);
	if (email.error) {
		return { error: email.error };
	}
	const phones = { ...(kept.phones ?? {}) };
	const phonesAdded = merged
		.map((card) =>
			unionInto(phones, card.phones, "p", (p) => phoneKey(p.number))
		)
		.some(Boolean);
	const addresses = { ...(kept.addresses ?? {}) };
	// An address stored only as `full` text (as some CardDAV clients write it)
	// formats to an empty string, so its text is the identity instead.
	const addressesAdded = merged
		.map((card) =>
			unionInto(addresses, card.addresses, "a", (a) =>
				(formatCardAddress(a) || (a.full ?? "")).trim().toLowerCase()
			)
		)
		.some(Boolean);
	const patch: Record<string, unknown> = {
		...(email.emails ? { emails: email.emails } : {}),
		...(phonesAdded ? { phones } : {}),
		...(addressesAdded ? { addresses } : {}),
		...mergeName(kept, merged, conflicts),
		...mergeOrganization(kept, merged, conflicts),
		...mergeBirthday(kept, merged, conflicts),
		...mergeRoles(kept, merged, conflicts),
		...mergeNotes(kept, merged),
	};
	unmodeled(kept, merged, conflicts);
	return {
		conflicts,
		movedEmails: email.movedEmails,
		patch,
		...(email.preferred ? { preferred: email.preferred } : {}),
	};
};
