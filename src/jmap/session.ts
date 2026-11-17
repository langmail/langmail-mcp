// JMAP session discovery.
//
// The session resource changes rarely (accountId is stable for the
// lifetime of a mailbox), so callers cache it (see `live.ts`). Auth is
// caller-provided: every wrapper is handed the complete `Authorization`
// header value — this module never mints or wraps credentials.

import { jmapTimeoutSignal } from "./timeout.ts";
import type { JmapSession } from "./types.ts";

export class JmapError extends Error {
	status: number;
	// RFC 8620 method-level error type (e.g. "cannotCalculateChanges") when the
	// server answered the call with an `error` method response; undefined for
	// transport-level failures. Lets callers branch on recoverable conditions.
	errorType: string | undefined;
	constructor(status: number, message: string, errorType?: string) {
		super(message);
		this.status = status;
		this.errorType = errorType;
		this.name = "JmapError";
	}
}

const TRAILING_SLASHES_RE = /\/+$/u;

// The `Authorization` header value for a credential. Every tool is handed the
// user's credential as the complete header value already (`Basic …` for an app
// password, `Bearer …` for a token; see `src/config.ts`), so this returns it
// unchanged. It marks the one place a tool turns "the credential" into "what
// goes on the wire", for JMAP and CalDAV alike.
export const authorizationHeader = (credential: string): string => credential;

export const fetchSession = async (
	stalwartBase: string,
	authorization: string
): Promise<JmapSession> => {
	const url = `${stalwartBase.replace(TRAILING_SLASHES_RE, "")}/.well-known/jmap`;
	const res = await fetch(url, {
		headers: { authorization },
		signal: jmapTimeoutSignal(),
	});
	if (res.status !== 200) {
		throw new JmapError(res.status, `jmap session returned ${res.status}`);
	}
	const body = (await res.json()) as Record<string, unknown>;
	const { apiUrl } = body;
	const { downloadUrl } = body;
	const { uploadUrl } = body;
	const { primaryAccounts } = body;
	const { username } = body;
	// downloadUrl and uploadUrl are mandatory in the session resource
	// (RFC 8620 §2) and Stalwart always sends them — a session without
	// either is malformed.
	if (
		typeof apiUrl !== "string" ||
		typeof downloadUrl !== "string" ||
		typeof uploadUrl !== "string" ||
		typeof primaryAccounts !== "object"
	) {
		throw new JmapError(200, "malformed jmap session response");
	}
	return {
		apiUrl,
		downloadUrl,
		primaryAccounts: primaryAccounts as Record<string, string>,
		uploadUrl,
		// Stalwart answers a request without a credential with an anonymous
		// session whose username is empty: that is not an identity.
		...(typeof username === "string" && username !== "" ? { username } : {}),
	};
};

export const accountIdForMail = (session: JmapSession): string => {
	const id = session.primaryAccounts["urn:ietf:params:jmap:mail"];
	if (!id) {
		throw new JmapError(200, "no primary mail account in session");
	}
	return id;
};

// Stalwart serves the Sieve capability (RFC 9661) on the same account as
// mail; the fallback covers a session resource that only advertises the
// mail primary.
export const accountIdForSieve = (session: JmapSession): string =>
	session.primaryAccounts["urn:ietf:params:jmap:sieve"] ??
	accountIdForMail(session);

// Same story for the contacts capability (RFC 9610): Stalwart hosts address
// books on the mail account, so fall back to the mail primary when the
// session omits a contacts primary.
export const accountIdForContacts = (session: JmapSession): string =>
	session.primaryAccounts["urn:ietf:params:jmap:contacts"] ??
	accountIdForMail(session);

// And for submission (RFC 8621 §7): identities and submissions live on the
// account that owns the mail, so the mail primary is the fallback.
export const accountIdForSubmission = (session: JmapSession): string =>
	session.primaryAccounts["urn:ietf:params:jmap:submission"] ??
	accountIdForMail(session);
