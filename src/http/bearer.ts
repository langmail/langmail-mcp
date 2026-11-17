// The static bearer token that guards the HTTP transport.
//
// A caller proves it may use the server by sending
// `Authorization: Bearer <MCP_AUTH_TOKEN>`. Anything else — no header, another
// scheme, a wrong token — gets the same 401, and that answer says nothing
// about the server behind it.

import { createHash, timingSafeEqual } from "node:crypto";

const HTTP_UNAUTHORIZED = 401;

// The scheme name is case-insensitive (RFC 9110 §11.1); the token is not.
const BEARER_RE = /^Bearer +(\S+)$/iu;

const digest = (value: string): Buffer =>
	createHash("sha256").update(value, "utf8").digest();

const unauthorized = (): Response =>
	new Response(`${JSON.stringify({ error: "unauthorized" })}\n`, {
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
			"www-authenticate": "Bearer",
		},
		status: HTTP_UNAUTHORIZED,
	});

/** Returns nothing when the request carries the token, and the 401 to answer with when it does not. */
export type BearerGate = (req: Request) => Response | undefined;

export const createBearerGate = (token: string): BearerGate => {
	const expected = digest(token);
	return (req) => {
		const presented = BEARER_RE.exec(
			req.headers.get("authorization") ?? ""
		)?.[1];
		// Both sides are hashed first: the digests have one length whatever was
		// sent, so the comparison takes the same time for every wrong token and
		// tells a caller nothing about the real one, not even its length.
		const matches = timingSafeEqual(digest(presented ?? ""), expected);
		return presented !== undefined && matches ? undefined : unauthorized();
	};
};
