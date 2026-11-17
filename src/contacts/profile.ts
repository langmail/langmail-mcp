// The authored half of a contact: the standard vCard fields a user keeps
// about a person — phone numbers, postal addresses, an organization, a free
// note — mapped between the JSContact card shape and a flat domain shape the
// MCP tools can accept and render.
//
// Deliberately bounded to properties that appear on a standard vCard
// (RFC 9553 §2.3.3 Phone, §2.5.1 Address, §2.2.3 Organization, §2.8.1 Note).
// Notes, phones and organizations are where an email client starts growing a
// CRM by accident; the vCard surface is the line that keeps that from
// happening incrementally.
//
// Postal addresses are structured rather than one free-text block: address
// formats are country-specific, and an agent addressing a letter needs the
// components separately.

import type {
	ContactCard,
	ContactCardAddress,
	ContactCardAddressComponent,
	ContactCardAnniversary,
	ContactCardNote,
	ContactCardPhone,
	ContactCardTitle,
} from "../jmap/index.ts";

import { daysInMonth } from "./birthdays.ts";
import { COLLECTED_UID_PREFIX, readCollected } from "./card.ts";
import {
	BIRTHDAY_KEY,
	COLLECTED_NOTE_KEY,
	USER_NOTE_KEY,
} from "./constants.ts";
import type {
	Birthday,
	ContactSource,
	PhoneLabel,
	PhoneNumber,
	PostalAddress,
	PostalLabel,
	StoredPhoneNumber,
	StoredPostalAddress,
} from "./types.ts";

// --- postal addresses ------------------------------------------------------

// JSContact has no `home` context — `private` is its spelling.
const POSTAL_CONTEXT: Record<PostalLabel, string | undefined> = {
	home: "private",
	other: undefined,
	work: "work",
};

// The RFC 9553 component kinds this flat model maps one-to-one. Everything
// else a CardDAV client may have written — `number`, `apartment`, `building`,
// `floor`, `district`, `postOfficeBox` — belongs to the street line: it is
// read as part of `street` and rewritten as one component when `street` is
// replaced, so a correction can neither lose it nor duplicate it.
const LOCALITY_KIND = "locality";
const POSTCODE_KIND = "postcode";
const REGION_KIND = "region";
const STREET_KIND = "name";
const COUNTRY_KIND = "country";
const NON_STREET_KINDS = new Set([
	LOCALITY_KIND,
	POSTCODE_KIND,
	REGION_KIND,
	COUNTRY_KIND,
	"separator",
]);

const componentValue = (
	components: ContactCardAddressComponent[] | null | undefined,
	kind: string
): string | undefined =>
	components?.find((c) => c.kind === kind && c.value)?.value;

const componentList = (
	address: ContactCardAddress
): ContactCardAddressComponent[] => address.components ?? [];

// Everything that renders on the street line, in stored order — the house
// number an imported card keeps separate from the street name included.
const streetOf = (address: ContactCardAddress): string | undefined => {
	const line = componentList(address)
		.filter((c) => !NON_STREET_KINDS.has(c.kind) && c.value.trim().length > 0)
		.map((c) => c.value.trim())
		.join(" ");
	return line.length > 0 ? line : undefined;
};

const postalLabelOf = (contexts: Record<string, boolean>): PostalLabel => {
	if (contexts.work) {
		return "work";
	}
	return contexts.private ? "home" : "other";
};

// One-line rendering off the card itself, so it stays right for a card whose
// components we do not model one-to-one. Written to `full` on every write so
// CardDAV clients that only render the formatted form show something sensible.
export const formatCardAddress = (address: ContactCardAddress): string => {
	const part = (kind: string): string =>
		componentValue(address.components, kind)?.trim() ?? "";
	const cityLine = [part(POSTCODE_KIND), part(LOCALITY_KIND)]
		.filter((p) => p.length > 0)
		.join(" ");
	const country = (address.countryCode ?? part(COUNTRY_KIND))
		.trim()
		.toUpperCase();
	return [streetOf(address) ?? "", cityLine, part(REGION_KIND), country]
		.filter((p) => p.length > 0)
		.join(", ");
};

const withFull = (address: ContactCardAddress): ContactCardAddress => {
	const full = formatCardAddress(address);
	return full.length > 0 ? { ...address, full } : address;
};

export const toCardAddress = (address: PostalAddress): ContactCardAddress => {
	const components: ContactCardAddressComponent[] = [];
	const push = (kind: string, value: string | undefined): void => {
		if (value && value.trim().length > 0) {
			components.push({ kind, value: value.trim() });
		}
	};
	// RFC 9553 component kinds: `name` is the street name, not the person's.
	push(STREET_KIND, address.street);
	push(POSTCODE_KIND, address.postalCode);
	push(LOCALITY_KIND, address.city);
	push(REGION_KIND, address.region);
	const context = POSTAL_CONTEXT[address.label];
	return withFull({
		components,
		...(context ? { contexts: { [context]: true } } : {}),
		...(address.country ? { countryCode: address.country.toUpperCase() } : {}),
	});
};

// Merges a correction onto a stored address *in place on the card shape*
// rather than rebuilding it from the flat read: a card written by another
// CardDAV client can carry components this model has no field for, and
// rebuilding would silently delete them from every synced device on a
// postal-code-only edit. Named components are replaced, everything else is
// left exactly where it was.
export const patchCardAddress = (
	original: ContactCardAddress,
	patch: Partial<PostalAddress> & { label?: PostalLabel }
): ContactCardAddress => {
	let components = componentList(original);
	const replace = (kind: string, value: string | undefined): void => {
		if (value === undefined) {
			return;
		}
		components = components.filter((c) => c.kind !== kind);
		if (value.trim().length > 0) {
			components.push({ kind, value: value.trim() });
		}
	};
	// Replacing the street replaces the whole street line — the read the caller
	// corrected against was that line joined, so anything less would leave a
	// stale house number stranded in front of the new street.
	if (patch.street !== undefined) {
		components = components.filter((c) => NON_STREET_KINDS.has(c.kind));
		replace(STREET_KIND, patch.street);
	}
	replace(POSTCODE_KIND, patch.postalCode);
	replace(LOCALITY_KIND, patch.city);
	replace(REGION_KIND, patch.region);
	if (patch.country !== undefined) {
		// The card carries the country in one place after this, never two.
		components = components.filter((c) => c.kind !== COUNTRY_KIND);
	}
	// Relabelling rewrites only the two contexts this model owns; a card's
	// `billing` / `delivery` markers are not ours to drop.
	const owned = new Set(Object.values(POSTAL_CONTEXT).filter(Boolean));
	const kept = Object.entries(original.contexts ?? {}).filter(
		([k]) => patch.label === undefined || !owned.has(k)
	);
	const added =
		patch.label === undefined ? undefined : POSTAL_CONTEXT[patch.label];
	const contexts = Object.fromEntries(added ? [...kept, [added, true]] : kept);
	return withFull({
		...original,
		components,
		...(Object.keys(contexts).length > 0 ? { contexts } : {}),
		...(patch.country === undefined
			? {}
			: { countryCode: patch.country.toUpperCase() }),
	});
};

// Defensive: cards are editable in any CardDAV client, so every part may be
// missing or shaped differently than we wrote it (a foreign client may carry
// the country as a component rather than `countryCode`).
const fromCardAddress = (
	key: string,
	address: ContactCardAddress
): StoredPostalAddress => {
	const part = (kind: string): string | undefined =>
		componentValue(address.components, kind);
	const city = part(LOCALITY_KIND);
	const country = address.countryCode ?? part(COUNTRY_KIND);
	const postalCode = part(POSTCODE_KIND);
	const region = part(REGION_KIND);
	const street = streetOf(address);
	return {
		...(city ? { city } : {}),
		...(country ? { country: country.toUpperCase() } : {}),
		// What the tools print: the card's own formatted line where it has one,
		// so an address with components we do not model still reads correctly.
		display: address.full?.trim() || formatCardAddress(address),
		key,
		label: postalLabelOf(address.contexts ?? {}),
		...(postalCode ? { postalCode } : {}),
		...(region ? { region } : {}),
		...(street ? { street } : {}),
	};
};

export const readPostalAddresses = (card: ContactCard): StoredPostalAddress[] =>
	Object.entries(card.addresses ?? {}).map(([key, address]) =>
		fromCardAddress(key, address)
	);

// --- phones ----------------------------------------------------------------

export const toCardPhone = (phone: PhoneNumber): ContactCardPhone => {
	const number = phone.number.trim();
	switch (phone.label) {
		case "fax":
			return { features: { fax: true }, number };
		case "home":
			return { contexts: { private: true }, features: { voice: true }, number };
		case "mobile":
			return { features: { mobile: true }, number };
		case "work":
			return { contexts: { work: true }, features: { voice: true }, number };
		default:
			return { number };
	}
};

// What the number is beats where it is used: a mobile stays `mobile` even on
// a card that also marks it as the work context.
const phoneLabelOf = (phone: ContactCardPhone): PhoneLabel => {
	const features = phone.features ?? {};
	const contexts = phone.contexts ?? {};
	if (features.mobile) {
		return "mobile";
	}
	if (features.fax) {
		return "fax";
	}
	if (contexts.work) {
		return "work";
	}
	return contexts.private ? "home" : "other";
};

const fromCardPhone = (
	key: string,
	phone: ContactCardPhone
): StoredPhoneNumber => ({
	key,
	label: phoneLabelOf(phone),
	number: phone.number,
});

export const readPhones = (card: ContactCard): StoredPhoneNumber[] =>
	Object.entries(card.phones ?? {}).map(([key, phone]) =>
		fromCardPhone(key, phone)
	);

// --- birthday --------------------------------------------------------------

// The JSContact anniversary kind CardDAV maps to vCard `BDAY` (RFC 9555).
// Every other kind (`wedding`, `death`, vendor values) is stored and
// preserved but never read, written or listed by the tools.
const BIRTH_KIND = "birth";

// Older vCard 3 clients wrote a birthday with no known year as
// `1604-MM-DD` (the Gregorian reform year, chosen as an obvious sentinel).
// Read as "no year" so nobody is reported as turning 422.
const UNKNOWN_YEAR_SENTINEL = 1604;

// A leap year to validate a yearless date against: `--02-29` is a real
// birthday, so February gets 29 days when no year says otherwise.
const LEAP_REFERENCE_YEAR = 2000;

// Month and day form a real calendar date (in the given year, or in any
// leap year when the year is unknown). Shared by the read side and the
// parser so an imported Feb 30 is skipped rather than clamped to Feb 28.
const isCalendarDate = (
	month: number,
	day: number,
	year: number | undefined
): boolean =>
	month >= 1 &&
	month <= 12 &&
	day >= 1 &&
	day <= daysInMonth(year ?? LEAP_REFERENCE_YEAR, month);

// The one calendar scale this model interprets; RFC 9553 defaults to it.
const GREGORIAN = "gregorian";

const birthEntries = (card: ContactCard): [string, ContactCardAnniversary][] =>
	Object.entries(card.anniversaries ?? {}).filter(
		([, a]) => a.kind === BIRTH_KIND
	);

// The first birth entry carrying at least a month and a day. A year-only
// birthday (legal in JSContact) is unusable for "coming up" and is skipped.
export const readBirthday = (card: ContactCard): Birthday | undefined => {
	for (const [, entry] of birthEntries(card)) {
		// Defensive on `date`: a malformed card from a foreign client must not
		// take down every contact read that renders a birthday line.
		const { calendarScale, day, month, year } = entry.date ?? {};
		// A month and day on another calendar scale (`chinese`, `hebrew`) mean
		// something else entirely; skipped rather than read as Gregorian.
		if (calendarScale && calendarScale !== GREGORIAN) {
			continue;
		}
		if (typeof month !== "number" || typeof day !== "number") {
			continue;
		}
		const known = typeof year === "number" && year !== UNKNOWN_YEAR_SENTINEL;
		// A foreign client can write a numerically shaped non-date (Feb 30);
		// that is no birthday, not one to clamp.
		if (isCalendarDate(month, day, known ? year : undefined)) {
			return { day, month, ...(known ? { year } : {}) };
		}
	}
};

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const YEARLESS_DATE = /^--(\d{2})-(\d{2})$/u;

// What both write tools call on the caller's text. `YYYY-MM-DD`, or
// `--MM-DD` when the year is unknown (the vCard 4 spelling, RFC 6350
// §4.3.1). The calendar date is validated: Feb 30 is rejected, `--02-29`
// is accepted because a leap-day birthday needs no particular year.
export const parseBirthday = (
	text: string
): { birthday: Birthday } | { error: string } => {
	const trimmed = text.trim();
	const full = FULL_DATE.exec(trimmed);
	const yearless = YEARLESS_DATE.exec(trimmed);
	if (!(full || yearless)) {
		return {
			error: `Birthday "${text}" is not a date. Use YYYY-MM-DD, or --MM-DD when the year is unknown.`,
		};
	}
	const year = full ? Number(full[1]) : undefined;
	const month = Number(full ? full[2] : yearless?.[1]);
	const day = Number(full ? full[3] : yearless?.[2]);
	if (!isCalendarDate(month, day, year)) {
		return {
			error: `Birthday "${text}" is not a calendar date — check the month and day.`,
		};
	}
	return { birthday: { day, month, ...(year === undefined ? {} : { year }) } };
};

// `1990-03-03`, or `--03-03` when the year is unknown — the spelling the
// tools accept, so what they print can be sent straight back.
export const formatBirthday = (birthday: Birthday): string => {
	const md = `${String(birthday.month).padStart(2, "0")}-${String(birthday.day).padStart(2, "0")}`;
	return birthday.year === undefined
		? `--${md}`
		: `${String(birthday.year).padStart(4, "0")}-${md}`;
};

// One birth entry as the tools write it — shared by create_contact (a fresh
// card) and withBirthday (a stored one), so the two can never diverge.
export const birthAnniversary = (
	birthday: Birthday
): ContactCardAnniversary => {
	const { day, month, year } = birthday;
	return {
		date: { day, month, ...(year === undefined ? {} : { year }) },
		kind: BIRTH_KIND,
	};
};

const freeKey = (taken: Record<string, unknown>, wanted: string): string => {
	let key = wanted;
	for (let n = 1; key in taken; n += 1) {
		key = `${wanted}-${n}`;
	}
	return key;
};

// The anniversaries map with the birth entry replaced (or removed when
// `birthday` is undefined) and every other entry — a wedding date a phone
// wrote, a vendor kind — left exactly where it was. A stored birth entry
// keeps its key so the edit lands in place on every synced device; a card
// without one takes the reserved key.
export const withBirthday = (
	card: ContactCard,
	birthday: Birthday | undefined
): Record<string, ContactCardAnniversary> => {
	const stored = card.anniversaries ?? {};
	const births = birthEntries(card);
	const kept = Object.fromEntries(
		Object.entries(stored).filter(([, a]) => a.kind !== BIRTH_KIND)
	);
	if (birthday === undefined) {
		return kept;
	}
	// A foreign entry may legally sit under the reserved key; it is never
	// overwritten — the birth entry takes the next free key instead.
	const [key, existing] = births[0] ?? [freeKey(kept, BIRTHDAY_KEY), undefined];
	return { ...kept, [key]: { ...existing, ...birthAnniversary(birthday) } };
};

// --- roles -----------------------------------------------------------------

// What a person is to the user ("lawyer", "landlord"), as the user said or
// confirmed it. Stored as a JSContact title of kind `role`, which CardDAV
// serves as vCard `ROLE` (RFC 9555): an ordinary field on every device, not
// a contact group the way `CATEGORIES` becomes one on a phone. Job titles
// (kind `title`, vCard `TITLE`) share the property and are never touched.
const ROLE_KIND = "role";

export const MAX_ROLES = 10;

const LEADING_MY = /^my\s+/u;
const SPACES = /\s+/gu;

const normalizeSpacing = (text: string): string =>
	text.trim().replace(SPACES, " ").toLowerCase();

// "My Lawyer " and "lawyer" are the same role: the user's phrase is the
// query, and a stored role is compared the same way.
export const normalizeRole = (text: string): string =>
	normalizeSpacing(text).replace(LEADING_MY, "");

// Whether the phrase names someone by what they are to the user ("my
// landlord"): the leading "my" that `normalizeRole` drops.
export const isRolePhrase = (text: string): boolean =>
	LEADING_MY.test(normalizeSpacing(text));

const roleEntries = (
	card: Pick<ContactCard, "titles">
): [string, ContactCardTitle][] =>
	Object.entries(card.titles ?? {}).filter(
		([, t]) => t.kind === ROLE_KIND && typeof t.name === "string"
	);

export const readRoles = (card: Pick<ContactCard, "titles">): string[] => [
	...new Set(
		roleEntries(card)
			.map(([, t]) => normalizeRole(t.name))
			.filter((r) => r.length > 0)
	),
];

// Whether one of the card's roles has a word starting with the (normalized)
// query: "lawyer" finds a "divorce lawyer", but a name search for "Ian"
// does not turn up everyone whose role is "physician".
export const hasRole = (
	card: Pick<ContactCard, "titles">,
	query: string
): boolean => {
	const q = normalizeRole(query);
	return q.length > 0 && readRoles(card).some((r) => ` ${r}`.includes(` ${q}`));
};

// The card's whole `titles` map with `removed` roles dropped and `added` ones
// appended under fresh keys, without duplicates. Every other title (a job
// title a phone wrote) keeps its key and value.
export const withRoles = (
	card: Pick<ContactCard, "titles">,
	added: string[],
	removed: string[]
): Record<string, ContactCardTitle> => {
	const gone = new Set(removed.map(normalizeRole));
	const titles: Record<string, ContactCardTitle> = Object.fromEntries(
		Object.entries(card.titles ?? {}).filter(
			([, t]) =>
				!(
					t.kind === ROLE_KIND &&
					typeof t.name === "string" &&
					gone.has(normalizeRole(t.name))
				)
		)
	);
	const present = new Set(readRoles({ titles }));
	for (const role of added.map(normalizeRole)) {
		if (role.length === 0 || present.has(role)) {
			continue;
		}
		present.add(role);
		titles[freeKey(titles, `r${Object.keys(titles).length}`)] = {
			kind: ROLE_KIND,
			name: role,
		};
	}
	return titles;
};

// --- organization, note, source -------------------------------------------

export const readOrganization = (card: ContactCard): string | undefined =>
	Object.values(card.organizations ?? {}).find((o) => o.name)?.name ??
	undefined;

// Every note entry except the machine-owned collection payload. A CardDAV
// client may have written its own entries under keys we don't control, so
// the read is "everything that isn't ours" rather than one fixed key.
export const readNote = (card: ContactCard): string | undefined => {
	const text = Object.entries(card.notes ?? {})
		.filter(([key]) => key !== COLLECTED_NOTE_KEY)
		.map(([, entry]) => entry.note)
		.filter((n) => typeof n === "string" && n.trim().length > 0)
		.join("\n\n");
	return text.length > 0 ? text : undefined;
};

// Which note entry a write lands in: the card's single existing user note if
// there is exactly one, so editing a note authored in a CardDAV client edits
// it in place instead of leaving two notes side by side.
export const userNoteKey = (card: ContactCard): string => {
	const keys = Object.keys(card.notes ?? {}).filter(
		(key) => key !== COLLECTED_NOTE_KEY
	);
	return keys.length === 1 ? (keys[0] as string) : USER_NOTE_KEY;
};

export const userNoteEntry = (note: string): ContactCardNote => ({ note });

// A card without a marker either predates the marker or came in through an
// address book we sync. Collection's own cards are recognisable without it,
// by the uid it mints or by membership in the Collected book (when the
// caller knows that book's id); anything else is imported.
export const sourceOf = (
	card: ContactCard,
	collectedBookId: string | undefined
): ContactSource => {
	const marked = readCollected(card).source;
	if (marked) {
		return marked;
	}
	const collected =
		card.uid?.startsWith(COLLECTED_UID_PREFIX) === true ||
		(collectedBookId !== undefined &&
			card.addressBookIds[collectedBookId] === true);
	return collected ? "derived" : "imported";
};
