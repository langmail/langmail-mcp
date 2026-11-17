// Thin glue over `tsdav`: RFC 6764 discovery + calendar listing + event
// PUT, each authenticated with the credential. A fresh, stateless call per
// request — same model as the JMAP wrappers in src/jmap.
//
// The transport details (well-known redirect to /dav/cal, principal ->
// calendar-home-set -> calendars) live inside tsdav; we thread the credential
// through, pin every request to the configured origin, and reshape the
// result into our CalendarSummary / DiscoveredAccount types.

import {
	createAccount,
	createCalendarObject,
	type DAVAccount,
	type DAVCalendar,
	type DAVCalendarObject,
	DAVNamespace,
	DAVNamespaceShort,
	davRequest,
	deleteCalendarObject,
	fetchCalendarObjects,
	fetchCalendarUserAddresses,
	getDAVAttribute,
	makeCalendar,
	updateCalendarObject,
} from "tsdav";

import { parseEvents } from "../ical/index.ts";
import {
	authorizationHeader,
	OriginMismatchError,
	originPinnedFetch,
} from "../jmap/index.ts";

import type {
	CalendarObject,
	CalendarSummary,
	DiscoveredAccount,
} from "./types.ts";

class CalDavError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = "CalDavError";
	}
}

export interface CalDavConfig {
	// Builds the request headers from the per-request credential. By default
	// the credential, which is the complete Authorization header value
	// (`Basic …` or `Bearer …`), is sent unchanged.
	authHeaders?: (credential: string) => Record<string, string>;
	// Stalwart base URL; tsdav discovers /dav/cal via /.well-known/caldav.
	serverUrl: string;
}

const DEFAULT_CAL_RE = /\/default\/?$/u;
const MAILTO_RE = /^mailto:/iu;
// A 2xx code in a status line like "HTTP/1.1 200 OK" (padded, so "HTTP/1.1 200" matches too).
const SUCCESS_STATUS_LINE_RE = / 2\d\d /u;

// Same order as the JMAP deadline (src/jmap/timeout.ts): enough for a
// legitimately slow REPORT over a large calendar, short enough that a stalled
// Stalwart becomes a logged error instead of a tool call that never returns.
const CALDAV_TIMEOUT_MS = 30_000;

// tsdav threads `fetchOptions` into every fetch it makes, including the several
// requests a single `createAccount` discovery performs (verified against tsdav
// 2.3.0), so one signal bounds every request it covers. It must be built per
// use — a signal created once at module load would already be expired.
//
// Each exported function below builds exactly one and shares it across the
// tsdav calls it makes, so the deadline bounds the *function*, not each
// round-trip inside it. A tool that calls two of them in sequence (discover,
// then write) therefore has two windows, not one: the deadline turns a stall
// into an error, and is not a per-tool latency budget.
const deadline = (): RequestInit => ({
	signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
});

const authHeaders = (
	cfg: CalDavConfig,
	credential: string
): Record<string, string> =>
	cfg.authHeaders
		? cfg.authHeaders(credential)
		: { authorization: authorizationHeader(credential) };

// What every tsdav call is given: the credential, the deadline, and a `fetch`
// that refuses any URL off the configured server's origin. tsdav follows the
// `/.well-known/caldav` redirect and the hrefs of a multistatus wherever they
// point and re-sends its headers there, so the pin is what keeps the
// credential on the user's own server. The three travel together on purpose:
// a call site cannot send the credential without the pin.
const transport = (
	cfg: CalDavConfig,
	credential: string,
	fetchOptions: RequestInit = deadline()
): {
	fetch: typeof fetch;
	fetchOptions: RequestInit;
	headers: Record<string, string>;
} => ({
	fetch: originPinnedFetch(cfg.serverUrl, "CalDAV") as typeof fetch,
	fetchOptions,
	headers: authHeaders(cfg, credential),
});

// CalDAV collection URLs are canonically trailing-slashed; tsdav resolves
// object URLs via `new URL(filename, url)`, which silently drops the last
// path segment without it. Normalize before comparing or PUTting so the
// membership check and the PUT can't disagree on the same calendar.
export const withTrailingSlash = (url: string): string =>
	url.endsWith("/") ? url : `${url}/`;

const toSummary = (cal: DAVCalendar): CalendarSummary => ({
	// Guarded like displayName: a color sent with attributes parses to an object.
	...(typeof cal.calendarColor === "string" && cal.calendarColor
		? { color: cal.calendarColor }
		: {}),
	displayName: typeof cal.displayName === "string" ? cal.displayName : "",
	url: cal.url,
});

// The calendar an unqualified event lands in: Stalwart auto-provisions a
// `.../default/` collection, so prefer that; otherwise the first listed.
export const pickDefaultCalendar = (
	calendars: CalendarSummary[]
): string | null => {
	const def = calendars.find((c) => DEFAULT_CAL_RE.test(c.url));
	return (def ?? calendars[0])?.url ?? null;
};

// Resolves the calendar a tool should act on. With no explicit request it
// falls back to the discovered default; an explicit URL must name one of
// the principal's calendars (matched modulo trailing slash). Shared by the
// create/update/delete event tools so they agree on selection + errors.
export type ResolvedCalendar =
	| { ok: true; url: string }
	| { ok: false; reason: "none" | "not-found" };

export const resolveCalendarUrl = (
	account: DiscoveredAccount,
	requested?: string
): ResolvedCalendar => {
	const url = requested ?? account.defaultCalendarUrl;
	if (!url) {
		return { ok: false, reason: "none" };
	}
	if (
		requested &&
		!account.calendars.some(
			(c) => withTrailingSlash(c.url) === withTrailingSlash(requested)
		)
	) {
		return { ok: false, reason: "not-found" };
	}
	return { ok: true, url };
};

// The principal's `mailto:` calendar-user-address as a bare email.
// calendar-user-address-set (RFC 6638) can list several hrefs — often
// the principal URL alongside the mailto — so we must pick the mailto
// one specifically; a non-mailto organizer would break iMIP routing.
export const pickOrganizer = (addresses: string[]): string | null => {
	const mail = addresses.find((a) => MAILTO_RE.test(a));
	return mail ? mail.replace(MAILTO_RE, "") : null;
};

// Takes the caller's deadline so a function that discovers *and* then acts is
// bounded once overall, rather than granting each leg a fresh window.
//
// tsdav's discovery tries further root URLs when one fails and reports only
// the last failure ("cannot find principalUrl"), which would bury a refused
// off-origin URL under a message that explains nothing. So the first refusal
// is kept and thrown once discovery returns, whether or not a later candidate
// answered: a server that points its CalDAV endpoints elsewhere is
// misconfigured, and the user should hear that rather than get half an answer.
const loadAccount = async (
	cfg: CalDavConfig,
	token: string,
	fetchOptions: RequestInit
): Promise<DAVAccount> => {
	const pinned = transport(cfg, token, fetchOptions);
	let refused: OriginMismatchError | undefined;
	const recording = (async (input: string | URL, init?: RequestInit) => {
		try {
			return await pinned.fetch(input, init);
		} catch (err) {
			if (err instanceof OriginMismatchError) {
				refused ??= err;
			}
			throw err;
		}
	}) as typeof fetch;
	let account: DAVAccount;
	try {
		account = await createAccount({
			account: { accountType: "caldav", serverUrl: cfg.serverUrl },
			...pinned,
			fetch: recording,
			loadCollections: true,
		});
	} catch (err) {
		throw refused ?? err;
	}
	if (refused) {
		throw refused;
	}
	return account;
};

export const fetchCalendarList = async (
	cfg: CalDavConfig,
	token: string
): Promise<CalendarSummary[]> => {
	const account = await loadAccount(cfg, token, deadline());
	return (account.calendars ?? []).map(toSummary);
};

export const discoverAccount = async (
	cfg: CalDavConfig,
	token: string
): Promise<DiscoveredAccount> => {
	const fetchOptions = deadline();
	const account = await loadAccount(cfg, token, fetchOptions);
	const addresses = await fetchCalendarUserAddresses({
		account,
		...transport(cfg, token, fetchOptions),
	});
	const calendars = (account.calendars ?? []).map(toSummary);
	return {
		calendars,
		defaultCalendarUrl: pickDefaultCalendar(calendars),
		organizer: pickOrganizer(addresses),
	};
};

export interface CreateCalendarParams {
	// Apple `calendar-color` (e.g. "#FF6600"); set on the MKCALENDAR so the
	// collection is born with a color rather than needing a follow-up PROPPATCH.
	color?: string;
	// Human display name, carried as the DAV `displayname` prop.
	name: string;
	token: string;
}

// Creates a new CalDAV calendar collection under the principal's
// calendar-home-set via MKCALENDAR, and returns its URL (trailing-slashed,
// ready for create_calendar_event). The collection's path segment is a fresh
// UUID — the human name lives in the `displayname` prop, not the URL — so
// retries or same-named calendars never collide on a path.
export const createCalendar = async (
	cfg: CalDavConfig,
	p: CreateCalendarParams
): Promise<string> => {
	const fetchOptions = deadline();
	const account = await loadAccount(cfg, p.token, fetchOptions);
	if (!account.homeUrl) {
		throw new Error("no calendar-home-set discovered for the principal");
	}
	// homeUrl comes back absolute from RFC 6764 discovery, so the returned URL is
	// directly usable as create_calendar_event's `calendarUrl`.
	const url = withTrailingSlash(
		`${withTrailingSlash(account.homeUrl)}${crypto.randomUUID()}`
	);
	const res = await makeCalendar({
		...transport(cfg, p.token, fetchOptions),
		props: {
			[`${DAVNamespaceShort.DAV}:displayname`]: { _text: p.name },
			...(p.color
				? {
						[`${DAVNamespaceShort.CALDAV_APPLE}:calendar-color`]: {
							_text: p.color,
						},
					}
				: {}),
		},
		url,
	});
	// An empty response array would otherwise slip past the `find` below and
	// report success without confirmation, so treat it as a failure.
	if (res.length === 0) {
		throw new Error("caldav MKCALENDAR returned no response");
	}
	const failed = res.find((r) => !r.ok);
	if (failed) {
		throw new CalDavError(
			failed.status,
			`caldav MKCALENDAR returned ${failed.status}`
		);
	}
	return url;
};

export interface UpdateCalendarParams {
	// New Apple `calendar-color`; omitted leaves the stored color alone.
	color?: string;
	// New `displayname`; omitted leaves the stored name alone.
	name?: string;
	token: string;
	url: string;
}

type Propstat = { status?: string } | undefined;

// Status lines of every propstat in a parsed multistatus. tsdav merges only
// the successful propstats into `props` and marks the response `ok` from the
// 207, so a refused property is otherwise invisible.
const propstatStatuses = (raw: unknown): string[] => {
	const multistatus = (
		raw as { multistatus?: { response?: unknown } } | undefined
	)?.multistatus;
	const responses = [multistatus?.response].flat() as (
		| { propstat?: Propstat | Propstat[] }
		| undefined
	)[];
	return responses
		.flatMap((r) => [r?.propstat].flat())
		.filter((p) => p !== undefined)
		.map((p) => p.status ?? "no status");
};

// Renames and/or recolors a calendar collection with one PROPPATCH of
// `displayname` and Apple `calendar-color` — the two props createCalendar
// sets on MKCALENDAR.
export const updateCalendar = async (
	cfg: CalDavConfig,
	p: UpdateCalendarParams
): Promise<void> => {
	const { headers, ...pinned } = transport(cfg, p.token);
	const res = await davRequest({
		...pinned,
		init: {
			body: {
				propertyupdate: {
					// tsdav's own prefix map, so the `ca:` on calendar-color is bound.
					_attributes: getDAVAttribute([
						DAVNamespace.DAV,
						DAVNamespace.CALDAV_APPLE,
					]),
					set: {
						prop: {
							...(p.name === undefined
								? {}
								: {
										[`${DAVNamespaceShort.DAV}:displayname`]: { _text: p.name },
									}),
							...(p.color
								? {
										[`${DAVNamespaceShort.CALDAV_APPLE}:calendar-color`]: {
											_text: p.color,
										},
									}
								: {}),
						},
					},
				},
			},
			headers,
			method: "PROPPATCH",
			namespace: DAVNamespaceShort.DAV,
		},
		url: p.url,
	});
	if (res.length === 0) {
		throw new Error("caldav PROPPATCH returned no response");
	}
	const isMultistatus =
		typeof res[0]?.raw === "object" &&
		res[0]?.raw !== null &&
		"multistatus" in res[0].raw;
	// tsdav takes a response's status from its propstats when every one fails,
	// so a refused property also lands here as `!ok`. Leave that to the propstat
	// check below, which names every refused status rather than just the first.
	const failed = isMultistatus ? undefined : res.find((r) => !r.ok);
	if (failed) {
		throw new CalDavError(
			failed.status,
			`caldav PROPPATCH returned ${failed.status}`
		);
	}
	// tsdav hangs the whole parsed document off every response, so read it once.
	const statuses = propstatStatuses(res[0]?.raw);
	const refused = statuses.filter(
		(status) => !SUCCESS_STATUS_LINE_RE.test(`${status} `)
	);
	if (refused.length > 0) {
		throw new Error(
			`caldav PROPPATCH refused a property: ${refused.join(", ")}`
		);
	}
	// RFC 4918 §9.2.1 requires a propstat per property, so a multistatus without
	// any confirms nothing. A reply that is not a multistatus at all (a bare 2xx)
	// is the server saying it applied the change, and passes.
	if (isMultistatus && statuses.length === 0) {
		throw new Error("caldav PROPPATCH confirmed no property");
	}
};

export interface PutEventParams {
	calendarUrl: string;
	ical: string;
	token: string;
}

// The name of a freshly created `.ics` resource. RFC 4791 §5.3.2 says the
// resource URL need bear no relationship to the object's properties, and §11
// says the name MUST NOT expose data from inside the object — so it is a bare
// UUID, generated independently of the event UID.
//
// Naming the resource after the UID is what made events created here invisible
// in Apple Calendar: our UIDs carried a domain, and since Stalwart 0.16.19 a
// `@` in a resource name is stored verbatim rather than percent-encoded,
// while clients ask for it percent-encoded.
export const newEventResourceName = (): string => `${crypto.randomUUID()}.ics`;

export const putEvent = async (
	cfg: CalDavConfig,
	p: PutEventParams
): Promise<void> => {
	const res = await createCalendarObject({
		calendar: { url: withTrailingSlash(p.calendarUrl) },
		...transport(cfg, p.token),
		filename: newEventResourceName(),
		iCalString: p.ical,
	});
	if (!res.ok) {
		throw new CalDavError(res.status, `caldav PUT returned ${res.status}`);
	}
};

// tsdav stringifies a missing getetag as the literal "undefined"; treat
// that as no ETag so we never send a bogus `If-Match: undefined`.
const normalizeEtag = (etag?: string): string | undefined =>
	etag && etag !== "undefined" ? etag : undefined;

// Reshapes a tsdav object into our CalendarObject, dropping anything the
// server returned without calendar data (e.g. a 404'd multiget href).
const toCalendarObject = (obj: DAVCalendarObject): CalendarObject | null => {
	if (typeof obj.data !== "string" || obj.data.length === 0) {
		return null;
	}
	const etag = normalizeEtag(obj.etag);
	return { data: obj.data, url: obj.url, ...(etag ? { etag } : {}) };
};

export interface FetchEventsParams {
	calendarUrl: string;
	// Optional inclusive window; without it every event in the calendar is
	// returned. Both bounds are iCalendar-style UTC or ISO 8601 strings.
	timeRange?: { end: string; start: string };
	token: string;
}

// Stalwart answers a calendar-query REPORT over an *empty* collection with a
// 404, which tsdav surfaces as a thrown "Collection query failed: 404". An
// empty calendar is a normal state, not an error, so we map it to an empty
// list (the calendar itself is already validated by resolveCalendarUrl, so a
// 404 here means "no events", not "no such calendar"). The pattern matches
// tsdav's internal error string (observed on tsdav 2.2.2) — re-check the
// message format on tsdav upgrades, or the 404 starts propagating again.
const EMPTY_COLLECTION_RE = /Collection query failed: 404\b/u;

export const isEmptyCollectionError = (err: unknown): boolean =>
	err instanceof Error && EMPTY_COLLECTION_RE.test(err.message);

// Lists the event objects in a calendar (optionally bounded by a time
// range) so the agent can discover UIDs to update/delete.
export const fetchEvents = async (
	cfg: CalDavConfig,
	p: FetchEventsParams
): Promise<CalendarObject[]> => {
	let objects: DAVCalendarObject[];
	try {
		objects = await fetchCalendarObjects({
			calendar: { url: withTrailingSlash(p.calendarUrl) },
			...transport(cfg, p.token),
			...(p.timeRange ? { timeRange: p.timeRange } : {}),
		});
	} catch (err) {
		if (isEmptyCollectionError(err)) {
			return [];
		}
		throw err;
	}
	return objects
		.map(toCalendarObject)
		.filter((o): o is CalendarObject => o !== null);
};

export interface FetchEventParams {
	calendarUrl: string;
	token: string;
	uid: string;
}

// Finds the stored object holding a given iCalendar UID among a collection's
// objects. CalDAV resource names are server-assigned and bear no relation to
// the UID — including for events we create ourselves (see
// newEventResourceName) — so we match on the parsed VEVENT UID rather than
// guessing the filename.
export const findEventObject = (
	objects: CalendarObject[],
	uid: string
): CalendarObject | null =>
	objects.find((o) => parseEvents(o.data).some((e) => e.uid === uid)) ?? null;

// Fetches the single event object carrying `uid`. Lists the collection and
// matches by UID (see findEventObject) so it works regardless of how the
// object was named — including events synced in from other clients. Returns
// null when no object carries the UID, surfaced as a friendly "not found".
export const fetchEvent = async (
	cfg: CalDavConfig,
	p: FetchEventParams
): Promise<CalendarObject | null> => {
	const objects = await fetchEvents(cfg, {
		calendarUrl: p.calendarUrl,
		token: p.token,
	});
	return findEventObject(objects, p.uid);
};

export interface UpdateEventParams {
	etag?: string;
	ical: string;
	token: string;
	url: string;
}

export const updateEvent = async (
	cfg: CalDavConfig,
	p: UpdateEventParams
): Promise<void> => {
	const res = await updateCalendarObject({
		calendarObject: { data: p.ical, etag: p.etag, url: p.url },
		...transport(cfg, p.token),
	});
	if (!res.ok) {
		throw new CalDavError(res.status, `caldav PUT returned ${res.status}`);
	}
};

export interface DeleteEventParams {
	etag?: string;
	token: string;
	url: string;
}

export const deleteEvent = async (
	cfg: CalDavConfig,
	p: DeleteEventParams
): Promise<void> => {
	const res = await deleteCalendarObject({
		calendarObject: { data: "", etag: p.etag, url: p.url },
		...transport(cfg, p.token),
	});
	if (!res.ok) {
		throw new CalDavError(res.status, `caldav DELETE returned ${res.status}`);
	}
};

export interface MoveEventParams {
	// Absolute URL the event should live at afterwards: the destination
	// calendar's URL followed by the event's resource name.
	destination: string;
	token: string;
	// The event's current URL, verbatim as the listing returned it.
	url: string;
}

// What the server did with one MOVE. Every refusal left the event where it was.
export type MoveEventOutcome =
	| { kind: "moved" }
	// The destination calendar already holds an event with this UID (CALDAV:no-uid-conflict).
	| { kind: "uidConflict" }
	// The destination calendar already has a resource by this name (Overwrite: F).
	| { kind: "nameConflict" }
	| { kind: "forbidden" }
	| { kind: "failed"; status: number };

const NO_UID_CONFLICT_RE = /no-uid-conflict/u;

// Re-files one event in another calendar with a WebDAV MOVE (RFC 4918 §9.9).
// Stalwart re-parents the stored event without copying it and without an
// iTIP step: the iCalendar data, and with it the UID, overrides and alarms,
// stays byte-identical and no attendee hears about it. Only the ETag changes.
// `Overwrite: F` means a name collision refuses instead of replacing.
//
// Throws only when the exchange broke off (a timeout, a dropped connection);
// the server may have committed the move by then.
export const moveEvent = async (
	cfg: CalDavConfig,
	p: MoveEventParams
): Promise<MoveEventOutcome> => {
	const { headers, ...pinned } = transport(cfg, p.token);
	const [res] = await davRequest({
		...pinned,
		init: {
			body: null,
			headers: {
				...headers,
				destination: p.destination,
				overwrite: "F",
			},
			method: "MOVE",
			namespace: DAVNamespaceShort.DAV,
		},
		url: p.url,
	});
	const status = res?.status ?? 0;
	if (status === 201 || status === 204) {
		return { kind: "moved" };
	}
	// The UID precondition carries its element in the body; a name collision
	// answers with an empty one. Stalwart 1.0 sends the UID precondition with
	// 403 (RFC 4791 §5.3.2.1), 0.16 sent it with 412. davRequest hands back the
	// raw text for any non-2xx reply, so `raw` is a string here.
	const body = typeof res?.raw === "string" ? res.raw : "";
	if ((status === 403 || status === 412) && NO_UID_CONFLICT_RE.test(body)) {
		return { kind: "uidConflict" };
	}
	if (status === 412) {
		return { kind: "nameConflict" };
	}
	if (status === 403) {
		return { kind: "forbidden" };
	}
	return { kind: "failed", status };
};
