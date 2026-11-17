// Proves the Stalwart credential never leaves the origin of STALWART_URL,
// against the built server started as a user starts it (stdio).
//
// Needs no Stalwart: the test starts two local HTTP servers. The first stands
// in for a misconfigured Stalwart at the configured address; it names the
// second, which is on another origin, in its answers. The second records every
// request it receives and must receive none, with or without an Authorization
// header.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type { TestAccount } from "./support/admin.ts";
import { basicAuth } from "./support/env.ts";
import { type StdioServer, startStdioServer } from "./support/server.ts";
import { toolText } from "./support/tool-output.ts";

const ADDRESS = "origin-pinning@example.com";
const PASSWORD = "pw-origin-pinning-SECRET";
const AUTHORIZATION = basicAuth(ADDRESS, PASSWORD);
const BASE64 = AUTHORIZATION.slice("Basic ".length);

// Not an account on any server: only what the built server signs in with.
const ACCOUNT: TestAccount = {
	address: ADDRESS,
	authorization: AUTHORIZATION,
	id: "none",
	localPart: "origin-pinning",
	secret: PASSWORD,
};

interface Seen {
	authorization: string | undefined;
	method: string;
	url: string;
}

interface Loopback {
	origin: string;
	seen: Seen[];
}

type Reply = (req: IncomingMessage) => {
	body?: string;
	headers?: Record<string, string>;
	status: number;
};

const servers: Server[] = [];
let mcp: StdioServer | undefined;

const listen = async (reply: Reply): Promise<Loopback> => {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			seen.push({
				authorization: req.headers.authorization,
				method: req.method ?? "",
				url: req.url ?? "",
			});
			const { body, headers, status } = reply(req);
			res.writeHead(status, headers);
			res.end(body ?? "");
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, seen };
};

// The other origin answers everything as a mail server would, so a request
// that did arrive would not fail for lack of an answer.
const otherOrigin = (): Promise<Loopback> =>
	listen((req) =>
		req.method === "POST"
			? {
					body: JSON.stringify({ methodResponses: [] }),
					headers: { "content-type": "application/json" },
					status: 200,
				}
			: { body: "<x/>", status: 207 }
	);

const sessionAt = (origin: string): string =>
	JSON.stringify({
		apiUrl: `${origin}/jmap/`,
		downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
		primaryAccounts: { "urn:ietf:params:jmap:mail": "a" },
		uploadUrl: `${origin}/jmap/upload/{accountId}/`,
		username: ADDRESS,
	});

const JSON_HEADERS = { "content-type": "application/json" };

afterEach(async () => {
	await mcp?.stop();
	mcp = undefined;
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				})
		)
	);
});

const start = async (stalwart: Loopback): Promise<StdioServer> => {
	mcp = await startStdioServer(ACCOUNT, {
		env: { LOG_LEVEL: "info", STALWART_URL: stalwart.origin },
	});
	return mcp;
};

const call = async (
	server: StdioServer,
	name: string,
	args: Record<string, unknown>
): Promise<{ isError: boolean; text: string }> => {
	const result = await server.client.callTool({ arguments: args, name });
	return { isError: result.isError === true, text: toolText(result) };
};

const expectNoSecret = (text: string): void => {
	expect(text).not.toContain(PASSWORD);
	expect(text).not.toContain(BASE64);
};

const mismatch = (other: Loopback, stalwart: Loopback, lead: string): string =>
	`${lead} ${other.origin}, but this server is configured for ${stalwart.origin} (STALWART_URL). The credential is only ever sent to the configured address, so nothing was sent to ${other.origin}. Set Stalwart's public URL (scheme, hostname and port) to match STALWART_URL, or point STALWART_URL at ${other.origin}.`;

describe("the credential stays on the origin of STALWART_URL", () => {
	test("a JMAP session that advertises another origin fails the sign-in, and that origin hears nothing", async () => {
		const other = await otherOrigin();
		const stalwart: Loopback = await listen((req) => {
			if (req.url === "/.well-known/jmap") {
				return {
					body: sessionAt(other.origin),
					headers: JSON_HEADERS,
					status: 200,
				};
			}
			if (req.url === "/.well-known/caldav") {
				return {
					headers: { location: `${other.origin}/dav/cal` },
					status: 301,
				};
			}
			return { status: 404 };
		});
		const server = await start(stalwart);

		const mail = await call(server, "search_emails", { query: "invoice" });
		const calendar = await call(server, "list_calendars", {});

		const expected = mismatch(
			other,
			stalwart,
			"Stalwart advertises its JMAP endpoints at"
		);
		for (const answer of [mail, calendar]) {
			expect(answer.isError).toBe(true);
			expect(answer.text).toContain(expected);
			expectNoSecret(answer.text);
		}
		// Zero requests, not merely zero credentials.
		expect(other.seen).toEqual([]);
		// The configured server was asked, with the credential.
		expect(stalwart.seen.length).toBeGreaterThan(0);
		for (const request of stalwart.seen) {
			expect(request.authorization).toBe(AUTHORIZATION);
		}
		expectNoSecret(server.stderr());
	});

	test("a CalDAV discovery redirect to another origin fails the calendar tool, and that origin hears nothing", async () => {
		const other = await otherOrigin();
		// JMAP is in order here, so the sign-in succeeds and the calendar tool
		// goes on to CalDAV discovery.
		const stalwart: Loopback = await listen((req) => {
			if (req.url === "/.well-known/jmap") {
				return { headers: { location: "/jmap/session" }, status: 307 };
			}
			if (req.url === "/jmap/session") {
				return {
					body: sessionAt(stalwart.origin),
					headers: JSON_HEADERS,
					status: 200,
				};
			}
			if (req.url === "/.well-known/caldav") {
				return {
					headers: { location: `${other.origin}/dav/cal` },
					status: 301,
				};
			}
			return { status: 404 };
		});
		const server = await start(stalwart);

		const calendar = await call(server, "list_calendars", {});

		expect(calendar.isError).toBe(true);
		expect(calendar.text).toContain(
			mismatch(other, stalwart, "Stalwart points its CalDAV endpoints at")
		);
		expectNoSecret(calendar.text);
		expect(other.seen).toEqual([]);
		expect(stalwart.seen.map((request) => request.url)).toContain(
			"/.well-known/caldav"
		);
		expectNoSecret(server.stderr());
	});

	test("a redirect of the JMAP API to another origin is not followed", async () => {
		const other = await otherOrigin();
		const stalwart: Loopback = await listen((req) => {
			if (req.url === "/.well-known/jmap") {
				return {
					body: sessionAt(stalwart.origin),
					headers: JSON_HEADERS,
					status: 200,
				};
			}
			// Every API call is sent on to the other origin, body and all.
			return { headers: { location: `${other.origin}/jmap/` }, status: 307 };
		});
		const server = await start(stalwart);

		const mail = await call(server, "search_emails", { query: "invoice" });

		expect(mail.isError).toBe(true);
		expectNoSecret(mail.text);
		expect(other.seen).toEqual([]);
		expect(stalwart.seen.map((request) => request.url)).toContain("/jmap/");
	});
});
