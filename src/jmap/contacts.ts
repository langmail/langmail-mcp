// Typed JMAP wrappers for the contacts capability (RFC 9610) — AddressBook
// and ContactCard methods on the same endpoint and Authorization seam as the
// mail surface. Cards are JSContact (RFC 9553) narrowed to the properties
// Langmail reads; vendor extension properties (the collected-contacts
// payload) ride along untyped and are interpreted by `src/contacts`.

import { type JmapCall, jmapCall, methodResponse } from "./request.ts";
import { JmapError } from "./session.ts";
import type {
	AddressBookRecord,
	ContactCard,
	ContactCardDraft,
} from "./types.ts";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"];

interface SetError {
	description?: string;
	properties?: string[];
	type?: string;
}

// `type` is a JMAP error code (`invalidProperties`, `notFound`, …), not free
// text, so it is safe to surface. The server's `description` stays out: it is
// free-form and can quote the value it rejected — a name, a note, a phone
// number, a postal address — and these messages travel to off-box error
// tracking, whose redactor only strips bearer tokens and addresses. Same rule
// as the EmailSubmission wrapper, for the same reason.
const setErrorType = (err: SetError | undefined): string =>
	err?.type ?? "unknown";

// --- AddressBook/get -------------------------------------------------------

export interface AddressBookListParams extends JmapCall {
	accountId: string;
}

// An account holds a handful of books at most (personal + collected), so the
// read side is a single AddressBook/get with `ids: null` (fetch all).
export const addressBookList = async (
	p: AddressBookListParams
): Promise<AddressBookRecord[]> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			["AddressBook/get", { accountId: p.accountId, ids: null }, "0"],
		],
		using: USING,
	});
	const out = methodResponse<{ list?: AddressBookRecord[] }>(
		resp,
		"AddressBook/get",
		"0"
	);
	return out.list ?? [];
};

// --- AddressBook/set -------------------------------------------------------

export interface AddressBookCreateParams extends JmapCall {
	accountId: string;
	name: string;
}

// Create an address book and return the server-assigned id. Callers that
// provision lazily should list first — this throws if the server rejects.
export const addressBookCreate = async (
	p: AddressBookCreateParams
): Promise<string> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"AddressBook/set",
				{ accountId: p.accountId, create: { b0: { name: p.name } } },
				"0",
			],
		],
		using: USING,
	});
	const out = methodResponse<{
		created?: { b0?: { id?: string } };
		notCreated?: { b0?: SetError };
	}>(resp, "AddressBook/set", "0");
	const id = out.created?.b0?.id;
	if (!id) {
		const reason = out.notCreated?.b0;
		throw new JmapError(
			200,
			`AddressBook/set did not create a book: ${setErrorType(reason)}`,
			reason?.type
		);
	}
	return id;
};

// --- ContactCard/get -------------------------------------------------------

export interface ContactCardGetParams extends JmapCall {
	accountId: string;
	ids: string[];
}

export const contactCardGet = async (
	p: ContactCardGetParams
): Promise<ContactCard[]> => {
	if (p.ids.length === 0) {
		return [];
	}
	const resp = await jmapCall(p, {
		methodCalls: [
			["ContactCard/get", { accountId: p.accountId, ids: p.ids }, "0"],
		],
		using: USING,
	});
	const out = methodResponse<{ list?: ContactCard[] }>(
		resp,
		"ContactCard/get",
		"0"
	);
	return out.list ?? [];
};

// --- ContactCard/query -----------------------------------------------------

// RFC 9610 §5.5 filter conditions, narrowed to what the collection upsert
// and the contact write tools actually filter on. `email` and `name` match the
// respective properties; `text` matches across all textual properties.
// `uid` is an exact match that Stalwart 1.0 answers from the store, while
// `email`, `name` and `text` go through its asynchronous search index and
// miss a card for a moment after it is written.
export interface ContactCardFilterCondition {
	email?: string;
	inAddressBook?: string;
	name?: string;
	text?: string;
	uid?: string;
}

export type ContactCardFilter =
	| ContactCardFilterCondition
	| { conditions: ContactCardFilter[]; operator: "AND" | "NOT" | "OR" };

export interface ContactCardQueryParams extends JmapCall {
	accountId: string;
	filter?: ContactCardFilter;
	limit?: number;
	// Zero-based result offset (RFC 8620 §5.5) — the collection upsert pages
	// large candidate sets (backfill batches) through here.
	position?: number;
}

export const contactCardQuery = async (
	p: ContactCardQueryParams
): Promise<string[]> => {
	const args: Record<string, unknown> = {
		accountId: p.accountId,
		calculateTotal: false,
	};
	if (p.filter !== undefined) {
		args.filter = p.filter;
	}
	if (p.limit !== undefined) {
		args.limit = p.limit;
	}
	if (p.position !== undefined && p.position > 0) {
		args.position = p.position;
	}
	const resp = await jmapCall(p, {
		methodCalls: [["ContactCard/query", args, "0"]],
		using: USING,
	});
	const out = methodResponse<{ ids?: string[] }>(
		resp,
		"ContactCard/query",
		"0"
	);
	return out.ids ?? [];
};

// --- ContactCard/query + ContactCard/get: one page of the account ----------

export interface ContactCardPageParams extends JmapCall {
	accountId: string;
	limit: number;
	// Zero-based offset into the unfiltered, unsorted id list.
	position: number;
	// The card properties to read (`id` always comes back).
	properties: string[];
}

export interface ContactCardPage {
	// In the query's order. A card destroyed between the two calls is absent.
	cards: ContactCard[];
	// How many ids the query returned. Shorter than `limit` at the end of the
	// account, or where the server caps a query below `limit`.
	returned: number;
	// Cards in the account, when the server counts them (RFC 8620 §5.5 lets
	// it decline).
	total?: number;
}

// One page of every card in the account, in a single request: an unfiltered
// ContactCard/query and a ContactCard/get of its ids through a `#ids`
// back-reference, so a sweep of the whole account costs one round trip per
// page. Unfiltered, the query reads the store rather than the search index,
// so a card is in it from the moment it is written.
export const contactCardPage = async (
	p: ContactCardPageParams
): Promise<ContactCardPage> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"ContactCard/query",
				{
					accountId: p.accountId,
					calculateTotal: true,
					limit: p.limit,
					...(p.position > 0 ? { position: p.position } : {}),
				},
				"0",
			],
			[
				"ContactCard/get",
				{
					"#ids": { name: "ContactCard/query", path: "/ids", resultOf: "0" },
					accountId: p.accountId,
					properties: p.properties,
				},
				"1",
			],
		],
		using: USING,
	});
	const query = methodResponse<{ ids?: string[]; total?: number }>(
		resp,
		"ContactCard/query",
		"0"
	);
	const got = methodResponse<{ list?: ContactCard[] }>(
		resp,
		"ContactCard/get",
		"1"
	);
	const ids = query.ids ?? [];
	const byId = new Map((got.list ?? []).map((card) => [card.id, card]));
	const cards = ids.flatMap((id) => {
		const card = byId.get(id);
		return card ? [card] : [];
	});
	return {
		cards,
		returned: ids.length,
		...(query.total === undefined ? {} : { total: query.total }),
	};
};

// --- ContactCard/set -------------------------------------------------------

export interface ContactCardCreateParams extends JmapCall {
	accountId: string;
	card: ContactCardDraft;
}

// The card's `uid` is already held in its address book. Stalwart 1.0 answers
// that as `invalidProperties` on `uid` (assert_is_unique_uid in
// crates/jmap/src/contact/mod.rs), not with a type of its own, so this is the
// one shape callers can tell apart from a malformed card.
export class ContactUidTakenError extends JmapError {
	constructor() {
		super(
			200,
			"ContactCard/set did not create card: uid already in the address book",
			"invalidProperties"
		);
		this.name = "ContactUidTakenError";
	}
}

export const contactCardCreate = async (
	p: ContactCardCreateParams
): Promise<string> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"ContactCard/set",
				{ accountId: p.accountId, create: { c0: p.card } },
				"0",
			],
		],
		using: USING,
	});
	const out = methodResponse<{
		created?: { c0?: { id?: string } };
		notCreated?: { c0?: SetError };
	}>(resp, "ContactCard/set", "0");
	const id = out.created?.c0?.id;
	if (!id) {
		const reason = out.notCreated?.c0;
		if (
			reason?.type === "invalidProperties" &&
			reason.properties?.includes("uid")
		) {
			throw new ContactUidTakenError();
		}
		throw new JmapError(
			200,
			`ContactCard/set did not create card: ${setErrorType(reason)}`,
			reason?.type
		);
	}
	return id;
};

export interface ContactCardUpdateParams extends JmapCall {
	accountId: string;
	cardId: string;
	// RFC 8620 §5.3 PatchObject: JSON-Pointer paths to set (value) or remove
	// (null). Callers must escape `~` and `/` in keys per RFC 6901 — the
	// contacts package only uses generated keys, which never need it.
	patch: Record<string, unknown>;
}

export const contactCardUpdate = async (
	p: ContactCardUpdateParams
): Promise<void> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"ContactCard/set",
				{ accountId: p.accountId, update: { [p.cardId]: p.patch } },
				"0",
			],
		],
		using: USING,
	});
	const out = methodResponse<{
		notUpdated?: Record<string, SetError>;
		updated?: Record<string, unknown>;
	}>(resp, "ContactCard/set", "0");
	if (!(out.updated && p.cardId in out.updated)) {
		const reason = out.notUpdated?.[p.cardId];
		throw new JmapError(
			200,
			`ContactCard/set did not update ${p.cardId}: ${setErrorType(reason)}`,
			reason?.type
		);
	}
};

export interface ContactCardDestroyParams extends JmapCall {
	accountId: string;
	cardId: string;
}

// Removes the card from every address book it is in — RFC 9610 has no
// per-book unlink, so `destroy` is the only deletion primitive.
export const contactCardDestroy = async (
	p: ContactCardDestroyParams
): Promise<void> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			["ContactCard/set", { accountId: p.accountId, destroy: [p.cardId] }, "0"],
		],
		using: USING,
	});
	const out = methodResponse<{
		destroyed?: string[];
		notDestroyed?: Record<string, SetError>;
	}>(resp, "ContactCard/set", "0");
	if (!out.destroyed?.includes(p.cardId)) {
		const reason = out.notDestroyed?.[p.cardId];
		throw new JmapError(
			200,
			`ContactCard/set did not destroy ${p.cardId}: ${setErrorType(reason)}`,
			reason?.type
		);
	}
};

// --- ContactCard/set: merge --------------------------------------------------

export interface ContactCardMergeParams extends JmapCall {
	accountId: string;
	// The card that stays, and its patch (RFC 8620 §5.3).
	cardId: string;
	// The cards folded into it, destroyed in the same call.
	destroy: string[];
	patch: Record<string, unknown>;
}

// What the server did with each half of the merge. A JMAP /set is not
// atomic (RFC 8620 §5.3): the update can land while a destroy is refused,
// or the reverse, so the caller reports each part instead of one verdict.
export interface ContactCardMergeResult {
	destroyed: string[];
	// SetError type per card the server refused to destroy.
	notDestroyed: Record<string, string>;
	// SetError type when the update was refused; absent when it landed.
	updateError?: string;
}

// One ContactCard/set carrying the kept card's update and the merged cards'
// destroys, so a CardDAV client syncs the merge as one change rather than
// seeing a half-merged book between two calls. RFC 8620 §5.3 has the server
// apply the update before the destroys within the call.
export const contactCardMerge = async (
	p: ContactCardMergeParams
): Promise<ContactCardMergeResult> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"ContactCard/set",
				{
					accountId: p.accountId,
					destroy: p.destroy,
					update: { [p.cardId]: p.patch },
				},
				"0",
			],
		],
		using: USING,
	});
	const out = methodResponse<{
		destroyed?: string[] | null;
		notDestroyed?: Record<string, SetError> | null;
		notUpdated?: Record<string, SetError> | null;
		updated?: Record<string, unknown> | null;
	}>(resp, "ContactCard/set", "0");
	const updated =
		out.updated !== undefined &&
		out.updated !== null &&
		p.cardId in out.updated;
	const destroyed = out.destroyed ?? [];
	const notDestroyed = Object.fromEntries(
		p.destroy
			.filter((id) => !destroyed.includes(id))
			.map((id) => [id, setErrorType(out.notDestroyed?.[id])])
	);
	return {
		destroyed,
		notDestroyed,
		...(updated
			? {}
			: { updateError: setErrorType(out.notUpdated?.[p.cardId]) }),
	};
};
