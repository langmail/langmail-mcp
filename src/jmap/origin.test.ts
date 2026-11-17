import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import {
	jmapFetch,
	OriginMismatchError,
	originPinnedFetch,
	pinSessionUrl,
} from "./origin.ts";
import { fetchSession } from "./session.ts";

const CREDENTIAL = "Basic dXNlckBleGFtcGxlLmNvbTpwdy1TRUNSRVQ=";

interface Seen {
	authorization: string | undefined;
	body: string;
	method: string | undefined;
	url: string | undefined;
}

interface Loopback {
	origin: string;
	seen: Seen[];
}

const servers: Server[] = [];

type Reply = (req: IncomingMessage) => {
	body?: string;
	headers?: Record<string, string>;
	status: number;
};

// A loopback server that records every request it receives.
const listen = async (reply: Reply): Promise<Loopback> => {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				authorization: req.headers.authorization,
				body: Buffer.concat(chunks).toString(),
				method: req.method,
				url: req.url,
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

afterEach(async () => {
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

const other = (): Promise<Loopback> => listen(() => ({ status: 200 }));

const session = (base: string): string =>
	JSON.stringify({
		apiUrl: `${base}/jmap/`,
		downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
		primaryAccounts: { "urn:ietf:params:jmap:mail": "a" },
		uploadUrl: `${base}/jmap/upload/{accountId}/`,
		username: "user@example.com",
	});

describe("pinSessionUrl", () => {
	const BASE = "https://mail.example.com";

	test("returns an absolute URL on the configured origin as it came", () => {
		const template = `${BASE}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`;
		expect(pinSessionUrl(template, BASE)).toBe(template);
		expect(pinSessionUrl(template, `${BASE}/`)).toBe(template);
	});

	test("resolves a relative URL against the base and keeps its template braces", () => {
		expect(pinSessionUrl("/jmap/", BASE)).toBe(`${BASE}/jmap/`);
		expect(pinSessionUrl("/jmap/upload/{accountId}/", BASE)).toBe(
			`${BASE}/jmap/upload/{accountId}/`
		);
	});

	test.each([
		["another host", "https://other.example.com/jmap/"],
		["http where https is configured", "http://mail.example.com/jmap/"],
		["another port", "https://mail.example.com:8443/jmap/"],
		[
			"a host that only starts the same",
			"https://mail.example.com.evil.example/",
		],
		[
			"userinfo that looks like the host",
			"https://mail.example.com@other.example.com/",
		],
	])("refuses %s", (_name, url) => {
		const err = (() => {
			try {
				pinSessionUrl(url, BASE);
			} catch (error) {
				return error;
			}
		})();
		expect(err).toBeInstanceOf(OriginMismatchError);
		expect((err as OriginMismatchError).expected).toBe(BASE);
		expect((err as OriginMismatchError).actual).toBe(new URL(url).origin);
	});

	test("says which two origins disagree and how to fix it", () => {
		expect(() =>
			pinSessionUrl("http://stalwart.internal:8080/jmap/", BASE)
		).toThrow(
			"Stalwart advertises its JMAP endpoints at http://stalwart.internal:8080, but this server is configured for https://mail.example.com (STALWART_URL). The credential is only ever sent to the configured address, so nothing was sent to http://stalwart.internal:8080. Set Stalwart's public URL (scheme, hostname and port) to match STALWART_URL, or point STALWART_URL at http://stalwart.internal:8080."
		);
	});
});

describe("fetchSession", () => {
	test("refuses a session that advertises its endpoints on another origin", async () => {
		const elsewhere = await other();
		const stalwart = await listen(() => ({
			body: session(elsewhere.origin),
			headers: { "content-type": "application/json" },
			status: 200,
		}));
		const err = await fetchSession(stalwart.origin, CREDENTIAL).catch(
			(error) => error
		);
		expect(err).toBeInstanceOf(OriginMismatchError);
		expect(err.message).toContain(elsewhere.origin);
		expect(err.message).toContain(stalwart.origin);
		expect(err.message).not.toContain("dXNlckBleGFtcGxlLmNvbTpwdy1TRUNSRVQ");
		expect(elsewhere.seen).toEqual([]);
	});

	test.each(["apiUrl", "downloadUrl", "uploadUrl"])(
		"refuses a session whose %s alone is on another origin",
		async (field) => {
			const elsewhere = await other();
			const stalwart = await listen(() => ({
				body: JSON.stringify({
					...JSON.parse(session(stalwart.origin)),
					[field]: `${elsewhere.origin}/x/{accountId}`,
				}),
				status: 200,
			}));
			await expect(
				fetchSession(stalwart.origin, CREDENTIAL)
			).rejects.toBeInstanceOf(OriginMismatchError);
			expect(elsewhere.seen).toEqual([]);
		}
	);

	test("follows the well-known redirect on the same origin, with the credential", async () => {
		const stalwart = await listen((req) =>
			req.url === "/.well-known/jmap"
				? { headers: { location: "/jmap/session" }, status: 307 }
				: {
						body: JSON.stringify({
							apiUrl: "/jmap/",
							downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}",
							primaryAccounts: { "urn:ietf:params:jmap:mail": "a" },
							uploadUrl: "/jmap/upload/{accountId}/",
							username: "user@example.com",
						}),
						status: 200,
					}
		);
		const s = await fetchSession(stalwart.origin, CREDENTIAL);
		expect(stalwart.seen.map((r) => [r.url, r.authorization])).toEqual([
			["/.well-known/jmap", CREDENTIAL],
			["/jmap/session", CREDENTIAL],
		]);
		// Relative URLs resolve against the configured base.
		expect(s.apiUrl).toBe(`${stalwart.origin}/jmap/`);
		expect(s.uploadUrl).toBe(`${stalwart.origin}/jmap/upload/{accountId}/`);
	});

	test("refuses a well-known redirect to another origin without following it", async () => {
		const elsewhere = await other();
		const stalwart = await listen(() => ({
			headers: { location: `${elsewhere.origin}/jmap/session` },
			status: 307,
		}));
		await expect(fetchSession(stalwart.origin, CREDENTIAL)).rejects.toThrow(
			`Stalwart redirected a JMAP request to ${elsewhere.origin}, but this server is configured for ${stalwart.origin} (STALWART_URL).`
		);
		expect(elsewhere.seen).toEqual([]);
	});
});

describe("originPinnedFetch", () => {
	test("refuses a URL on another origin before sending anything", async () => {
		const elsewhere = await other();
		const stalwart = await other();
		const pinned = originPinnedFetch(stalwart.origin, "CalDAV");
		await expect(
			pinned(`${elsewhere.origin}/dav/cal/`, {
				headers: { authorization: CREDENTIAL },
				method: "PROPFIND",
			})
		).rejects.toThrow(
			`Stalwart points its CalDAV endpoints at ${elsewhere.origin}, but this server is configured for ${stalwart.origin} (STALWART_URL).`
		);
		expect(elsewhere.seen).toEqual([]);
		expect(stalwart.seen).toEqual([]);
	});

	test("treats localhost and 127.0.0.1 as different origins", async () => {
		const stalwart = await other();
		const pinned = originPinnedFetch(stalwart.origin, "JMAP");
		await expect(
			pinned(stalwart.origin.replace("127.0.0.1", "localhost"))
		).rejects.toBeInstanceOf(OriginMismatchError);
		expect(stalwart.seen).toEqual([]);
	});

	test("hands a redirect back untouched to a caller that asks for redirect: manual", async () => {
		const elsewhere = await other();
		const stalwart = await listen(() => ({
			headers: { location: `${elsewhere.origin}/dav/cal` },
			status: 301,
		}));
		const res = await originPinnedFetch(stalwart.origin, "CalDAV")(
			`${stalwart.origin}/.well-known/caldav`,
			{ redirect: "manual" }
		);
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe(`${elsewhere.origin}/dav/cal`);
		expect(elsewhere.seen).toEqual([]);
	});

	test("repeats method, body and credential across a same-origin 307", async () => {
		const stalwart = await listen((req) =>
			req.url === "/a"
				? { headers: { location: "/b" }, status: 307 }
				: { body: "done", status: 200 }
		);
		const res = await originPinnedFetch(stalwart.origin, "JMAP")(
			`${stalwart.origin}/a`,
			{
				body: "payload",
				headers: { authorization: CREDENTIAL },
				method: "POST",
			}
		);
		expect(await res.text()).toBe("done");
		expect(stalwart.seen).toEqual([
			{ authorization: CREDENTIAL, body: "payload", method: "POST", url: "/a" },
			{ authorization: CREDENTIAL, body: "payload", method: "POST", url: "/b" },
		]);
	});

	test("turns a POST into a GET without a body after a 303", async () => {
		const stalwart = await listen((req) =>
			req.url === "/a"
				? { headers: { location: "/b" }, status: 303 }
				: { status: 200 }
		);
		await originPinnedFetch(stalwart.origin, "JMAP")(`${stalwart.origin}/a`, {
			body: "payload",
			method: "POST",
		});
		expect(stalwart.seen[1]).toMatchObject({
			body: "",
			method: "GET",
			url: "/b",
		});
	});

	test("gives up on a redirect loop", async () => {
		const stalwart = await listen(() => ({
			headers: { location: "/again" },
			status: 302,
		}));
		await expect(
			originPinnedFetch(stalwart.origin, "JMAP")(`${stalwart.origin}/a`)
		).rejects.toThrow("more than 5 times");
		expect(stalwart.seen).toHaveLength(6);
	});
});

describe("jmapFetch", () => {
	test("does not follow a redirect off the URL's own origin, so the request body stays put", async () => {
		const elsewhere = await other();
		const stalwart = await listen(() => ({
			headers: { location: `${elsewhere.origin}/jmap/` },
			status: 307,
		}));
		await expect(
			jmapFetch(`${stalwart.origin}/jmap/`, {
				body: "{}",
				headers: { authorization: CREDENTIAL },
				method: "POST",
			})
		).rejects.toBeInstanceOf(OriginMismatchError);
		expect(elsewhere.seen).toEqual([]);
	});
});
