// Pins every request that carries the Stalwart credential to one origin: the
// one the user configured as STALWART_URL.
//
// A mail server names further URLs in its answers: the JMAP session lists
// `apiUrl`, `downloadUrl` and `uploadUrl`, CalDAV discovery answers with a
// redirect and with hrefs, and any request can be redirected. Sending the
// `Authorization` header wherever those point would hand the credential to
// whatever host a misconfigured server or proxy names, for example an
// `http://` URL advertised by a Stalwart that sits behind a TLS proxy. So a
// URL on another origin is refused before anything is sent, and the error
// says which two origins disagree.
//
// Origin means scheme, host and port together: `http` against `https` on the
// same host is a mismatch, and the one that matters most.

export type PinnedService = "JMAP" | "CalDAV";

const fix = (actual: string): string =>
	`The credential is only ever sent to the configured address, so nothing was sent to ${actual}. Set Stalwart's public URL (scheme, hostname and port) to match STALWART_URL, or point STALWART_URL at ${actual}.`;

export class OriginMismatchError extends Error {
	// The origin a URL pointed at, and the configured one it had to match.
	actual: string;
	expected: string;
	constructor(lead: string, actual: string, expected: string) {
		super(
			`${lead} ${actual}, but this server is configured for ${expected} (STALWART_URL). ${fix(actual)}`
		);
		this.actual = actual;
		this.expected = expected;
		this.name = "OriginMismatchError";
	}
}

// The origin of an absolute http(s) URL. Never the full URL: an origin cannot
// carry a path, a query or credentials, so it is safe to put in an error.
const originOf = (url: string): string => new URL(url).origin;

// Throws unless `url` (absolute, or relative to `base`) is on the origin of
// `base`. Returns the absolute URL.
const assertSameOrigin = (url: string, base: string, lead: string): URL => {
	const resolved = new URL(url, base);
	const expected = originOf(base);
	if (resolved.origin !== expected) {
		throw new OriginMismatchError(lead, resolved.origin, expected);
	}
	return resolved;
};

const ENCODED_BRACE_RE = /%7B|%7D/giu;

// Checks one URL of the JMAP session resource against the configured base and
// returns it absolute. The URL may be a URI template (`{accountId}`), whose
// braces `URL` percent-encodes, so an absolute one is returned as it came and a
// relative one gets its braces back.
export const pinSessionUrl = (url: string, base: string): string => {
	const resolved = assertSameOrigin(
		url,
		base,
		"Stalwart advertises its JMAP endpoints at"
	);
	if (URL.canParse(url)) {
		return url;
	}
	return resolved.href.replace(ENCODED_BRACE_RE, (m) =>
		m.toUpperCase() === "%7B" ? "{" : "}"
	);
};

const MAX_REDIRECTS = 5;
const HTTP_MOVED_PERMANENTLY = 301;
const HTTP_FOUND = 302;
const HTTP_SEE_OTHER = 303;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_BAD_REQUEST = 400;

// What the next hop of a redirect sends (the fetch standard's rule): a 303, or
// a 301/302 answering a POST, turns into a GET without a body; everything else
// repeats the request as it was.
const afterRedirect = (
	status: number,
	init: RequestInit | undefined
): RequestInit | undefined => {
	const method = (init?.method ?? "GET").toUpperCase();
	const toGet =
		(status === HTTP_SEE_OTHER && method !== "GET" && method !== "HEAD") ||
		((status === HTTP_MOVED_PERMANENTLY || status === HTTP_FOUND) &&
			method === "POST");
	if (!toGet) {
		return init;
	}
	const { body: _body, ...rest } = init ?? {};
	return { ...rest, method: "GET" };
};

type PinnedFetch = (
	input: string | URL,
	init?: RequestInit
) => Promise<Response>;

/**
 * A `fetch` that only ever talks to the origin of `base`. A request to another
 * origin throws `OriginMismatchError` before anything is sent. Redirects are
 * followed by hand, so a redirect to another origin is refused the same way
 * instead of being followed with the request body. A caller that asks for
 * `redirect: "manual"` gets the redirect response back untouched (tsdav's
 * discovery does this and then requests the target through this same
 * function).
 */
export const originPinnedFetch = (
	base: string,
	service: PinnedService
): PinnedFetch => {
	const lead =
		service === "JMAP"
			? "Stalwart pointed a JMAP request at"
			: "Stalwart points its CalDAV endpoints at";
	return async (input, init) => {
		// The URL goes out as the caller wrote it; only a relative one is
		// replaced by what it resolves to.
		const first = assertSameOrigin(String(input), base, lead);
		let url = URL.canParse(String(input)) ? String(input) : first.href;
		if (init?.redirect === "manual") {
			return fetch(url, init);
		}
		let current = init;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			const res = await fetch(url, { ...current, redirect: "manual" });
			const location =
				res.status >= HTTP_MULTIPLE_CHOICES && res.status < HTTP_BAD_REQUEST
					? res.headers.get("location")
					: null;
			if (!location) {
				return res;
			}
			url = assertSameOrigin(
				new URL(location, url).href,
				base,
				`Stalwart redirected a ${service} request to`
			).href;
			await res.body?.cancel();
			current = afterRedirect(res.status, current);
		}
		throw new Error(
			`Stalwart redirected a ${service} request more than ${MAX_REDIRECTS} times`
		);
	};
};

/**
 * `fetch` for a URL that came out of an already checked JMAP session: it stays
 * on that URL's own origin, redirects included.
 */
export const jmapFetch = (url: string, init?: RequestInit): Promise<Response> =>
	originPinnedFetch(url, "JMAP")(url, init);
