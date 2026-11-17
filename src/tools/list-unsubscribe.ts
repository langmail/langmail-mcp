// Pure parsing for unsubscribe_from_list: what a message's RFC 2369
// `List-Unsubscribe` header offers, whether it qualifies for an RFC 8058
// one-click POST, what the link says about its own scope, and — for mail
// without the header — a visible footer link. No IO here; the tool and the
// guarded HTTP client live in unsubscribe-from-list.ts and one-click-post.ts.

import type { EmailUnsubscribeRecord } from "../jmap/index.ts";

export interface MailtoTarget {
	address: string;
	body?: string;
	subject?: string;
}

export interface ListUnsubscribe {
	// Every plain-http URL: never POSTed (RFC 8058 requires https), only reported.
	http: string[];
	// Every https URL, in header order.
	https: string[];
	mailto: MailtoTarget[];
	// RFC 8058: `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is present.
	oneClick: boolean;
}

// RFC 5322 §2.2.3: a folded header is a CRLF followed by whitespace; unfolding
// removes the CRLF. Bare LF is tolerated because not every store normalises.
const FOLD_RE = /\r?\n(?=[ \t])/gu;
const ANGLE_ENTRY_RE = /<([^>]*)>/gu;
const WHITESPACE_RE = /\s+/gu;

export const unfoldHeader = (raw: string): string =>
	raw.replaceAll(FOLD_RE, "");

// Sender text that ends up in the tool result: one line, so a `%0A` in a
// mailto subject cannot forge a line of the result.
const oneLine = (text: string): string =>
	text.replaceAll(WHITESPACE_RE, " ").trim();

// RFC 6068: `+` in a mailto query is a literal plus, not a space, so the
// pairs are percent-decoded by hand rather than through URLSearchParams.
const mailtoField = (query: string, name: string): string | undefined => {
	for (const pair of query.split("&")) {
		const eq = pair.indexOf("=");
		if (eq > 0 && pair.slice(0, eq).toLowerCase() === name) {
			const value = oneLine(decodeURIComponent(pair.slice(eq + 1)));
			return value || undefined;
		}
	}
	return undefined;
};

const parseMailto = (uri: string): MailtoTarget | null => {
	try {
		const rest = uri.slice("mailto:".length);
		const q = rest.indexOf("?");
		const address = oneLine(
			decodeURIComponent(q === -1 ? rest : rest.slice(0, q))
		);
		if (!address) {
			return null;
		}
		const query = q === -1 ? "" : rest.slice(q + 1);
		const subject = mailtoField(query, "subject");
		const body = mailtoField(query, "body");
		return {
			address,
			...(subject ? { subject } : {}),
			...(body ? { body } : {}),
		};
	} catch {
		// A malformed percent-escape: skip this entry, keep the others.
		return null;
	}
};

// RFC 2369 §2: the value is a comma-separated list of `<uri>` entries; a
// folded line may split it anywhere, and whitespace inside the angle brackets
// is to be ignored.
export const parseListUnsubscribe = (
	raw: string | null | undefined,
	post: string | null | undefined
): ListUnsubscribe => {
	const result: ListUnsubscribe = {
		http: [],
		https: [],
		mailto: [],
		oneClick: false,
	};
	if (!raw) {
		return result;
	}
	for (const match of unfoldHeader(raw).matchAll(ANGLE_ENTRY_RE)) {
		const uri = (match[1] ?? "").replaceAll(WHITESPACE_RE, "");
		const scheme = uri.slice(0, uri.indexOf(":") + 1).toLowerCase();
		if (scheme === "https:") {
			result.https.push(uri);
		} else if (scheme === "http:") {
			result.http.push(uri);
		} else if (scheme === "mailto:") {
			const target = parseMailto(uri);
			if (target) {
				result.mailto.push(target);
			}
		}
	}
	result.oneClick = result.https.length > 0 && isOneClickPost(post);
	return result;
};

// RFC 8058 §3.1: the Post header must contain exactly the key/value pair
// `List-Unsubscribe=One-Click`.
const POST_PAIR_SEPARATOR_RE = /[;&,]/u;

const isOneClickPost = (post: string | null | undefined): boolean =>
	(post ?? "")
		.split(POST_PAIR_SEPARATOR_RE)
		.some(
			(pair) =>
				pair.replaceAll(WHITESPACE_RE, "").toLowerCase() ===
				"list-unsubscribe=one-click"
		);

// What the URL says about how much it covers. Only the strong signal is named:
// the field test's publisher footer said "this mailing list" while the header
// link was `unsubscribe-all`.
const ALL_SCOPE_RE =
	/(?:unsub(?:scribe)?|opt-?out)[-_]?all|all[-_]?(?:unsub(?:scribe)?|opt-?out)/iu;

export const scopeNote = (url: string): string | null => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (ALL_SCOPE_RE.test(`${parsed.pathname}${parsed.search}`)) {
		return 'The link looks like "unsubscribe from all": it may stop all marketing mail from this sender, not just this list.';
	}
	return null;
};

// The host and path only: the query string carries the sender's tracking
// token and tells the user nothing.
export const describeUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname}`;
	} catch {
		return url;
	}
};

// A URL in the text body that names itself an unsubscribe or opt-out link.
// The body is whatever Stalwart resolved as the text body (text/plain, or the
// HTML part of an HTML-only message), so both plain URLs and href targets are
// found. A tracking redirect whose URL does not say "unsubscribe" is missed,
// which reports "no link found" rather than guessing.
const URL_RE = /https?:\/\/[^\s"'<>()]+/giu;
const FOOTER_HINT_RE = /unsub|opt-?out|optout/iu;
const HTML_AMP_RE = /&amp;/gu;

export const footerLink = (record: EmailUnsubscribeRecord): string | null => {
	const values = record.bodyValues ?? {};
	for (const part of record.textBody ?? []) {
		const text = part.partId ? (values[part.partId]?.value ?? "") : "";
		for (const match of text.matchAll(URL_RE)) {
			if (FOOTER_HINT_RE.test(match[0])) {
				return match[0].replaceAll(HTML_AMP_RE, "&");
			}
		}
	}
	return null;
};

// Delivered-To headers are prepended at each delivery hop, so the first one
// is the user's own mailbox; forwarded mail carries older hops below it.
export const deliveredTo = (record: EmailUnsubscribeRecord): string | null => {
	const first = record["header:Delivered-To:asText:all"]?.find((v) => v.trim());
	if (first) {
		return first.trim();
	}
	// Without the header, a single To recipient is the best guess; a list of
	// them would name other people's addresses as the user's.
	const to = (record.to ?? []).map((a) => a.email).filter(Boolean);
	return to.length === 1 ? (to[0] ?? null) : null;
};

export const formatMailto = (m: MailtoTarget): string =>
	[
		`  To: ${m.address}`,
		...(m.subject ? [`  Subject: ${m.subject}`] : []),
		...(m.body ? [`  Body: ${m.body}`] : []),
	].join("\n");
