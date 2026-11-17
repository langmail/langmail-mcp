// The credential stays on the configured server: every function of the CalDAV
// client that goes to the network is called with a URL on another origin, or
// against a server that points discovery at one, and that origin must receive
// nothing at all.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { OriginMismatchError } from "../jmap/index.ts";
// biome-ignore lint/performance/noNamespaceImport: the first test lists the module's exports to prove none is left out
import * as client from "./client.ts";

const CREDENTIAL = "Basic dXNlckBleGFtcGxlLmNvbTpwdy1TRUNSRVQ=";
const ICAL = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

interface Loopback {
	origin: string;
	seen: { authorization: string | undefined; method: string; url: string }[];
}

type Reply = (req: IncomingMessage) => {
	body?: string;
	headers?: Record<string, string>;
	status: number;
};

const servers: Server[] = [];

const listen = async (reply: Reply): Promise<Loopback> => {
	const seen: Loopback["seen"] = [];
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

// Answers everything, so a request that did arrive would look like a success.
const elsewhere = (): Promise<Loopback> =>
	listen(() => ({ body: "<x/>", status: 207 }));

const multistatus = (body: string): ReturnType<Reply> => ({
	body: `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`,
	headers: { "content-type": "application/xml" },
	status: 207,
});

const propstat = (href: string, prop: string): string =>
	`<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

// The functions that take the URL to act on. The calendar tools only pass
// URLs they found in the discovered calendar list, so this is the backstop.
const BY_URL: Record<
	string,
	(cfg: client.CalDavConfig, url: string) => Promise<unknown>
> = {
	deleteEvent: (cfg, url) =>
		client.deleteEvent(cfg, { token: CREDENTIAL, url: `${url}a.ics` }),
	fetchEvent: (cfg, url) =>
		client.fetchEvent(cfg, { calendarUrl: url, token: CREDENTIAL, uid: "u" }),
	fetchEvents: (cfg, url) =>
		client.fetchEvents(cfg, { calendarUrl: url, token: CREDENTIAL }),
	moveEvent: (cfg, url) =>
		client.moveEvent(cfg, {
			destination: `${cfg.serverUrl}/dav/cal/u/other/a.ics`,
			token: CREDENTIAL,
			url: `${url}a.ics`,
		}),
	putEvent: (cfg, url) =>
		client.putEvent(cfg, { calendarUrl: url, ical: ICAL, token: CREDENTIAL }),
	updateCalendar: (cfg, url) =>
		client.updateCalendar(cfg, { name: "n", token: CREDENTIAL, url }),
	updateEvent: (cfg, url) =>
		client.updateEvent(cfg, {
			ical: ICAL,
			token: CREDENTIAL,
			url: `${url}a.ics`,
		}),
};

// The functions that start from discovery.
const BY_DISCOVERY: Record<
	string,
	(cfg: client.CalDavConfig) => Promise<unknown>
> = {
	createCalendar: (cfg) =>
		client.createCalendar(cfg, { name: "n", token: CREDENTIAL }),
	discoverAccount: (cfg) => client.discoverAccount(cfg, CREDENTIAL),
	fetchCalendarList: (cfg) => client.fetchCalendarList(cfg, CREDENTIAL),
};

// Pure helpers: no network, nothing to pin.
const OFFLINE = new Set([
	"findEventObject",
	"isEmptyCollectionError",
	"newEventResourceName",
	"pickDefaultCalendar",
	"pickOrganizer",
	"resolveCalendarUrl",
	"withTrailingSlash",
]);

describe("the CalDAV client stays on the configured origin", () => {
	test("every exported function is either covered here or known to make no request", () => {
		const covered = [
			...Object.keys(BY_URL),
			...Object.keys(BY_DISCOVERY),
			...OFFLINE,
		].sort();
		const exported = Object.entries(client)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();
		expect(covered).toEqual(exported);
	});

	test.each(Object.keys(BY_URL))(
		"%s refuses a URL on another origin and sends nothing",
		async (name) => {
			const other = await elsewhere();
			const stalwart = await elsewhere();
			const err = await BY_URL[name]?.(
				{ serverUrl: stalwart.origin },
				`${other.origin}/dav/cal/u/default/`
			).catch((error: unknown) => error);
			expect(err).toBeInstanceOf(OriginMismatchError);
			expect((err as Error).message).toBe(
				`Stalwart points its CalDAV endpoints at ${other.origin}, but this server is configured for ${stalwart.origin} (STALWART_URL). The credential is only ever sent to the configured address, so nothing was sent to ${other.origin}. Set Stalwart's public URL (scheme, hostname and port) to match STALWART_URL, or point STALWART_URL at ${other.origin}.`
			);
			expect(other.seen).toEqual([]);
			expect(stalwart.seen).toEqual([]);
		}
	);

	test.each(Object.keys(BY_DISCOVERY))(
		"%s refuses a well-known redirect to another origin",
		async (name) => {
			const other = await elsewhere();
			const stalwart = await listen((req) =>
				req.url === "/.well-known/caldav"
					? { headers: { location: `${other.origin}/dav/cal` }, status: 301 }
					: { status: 404 }
			);
			const err = await BY_DISCOVERY[name]?.({
				serverUrl: stalwart.origin,
			}).catch((error: unknown) => error);
			expect(err).toBeInstanceOf(OriginMismatchError);
			expect((err as Error).message).toContain(other.origin);
			expect((err as Error).message).not.toContain(CREDENTIAL.slice(6));
			expect(other.seen).toEqual([]);
			// The configured server did get the credential: that is where it belongs.
			expect(stalwart.seen[0]).toEqual({
				authorization: CREDENTIAL,
				method: "PROPFIND",
				url: "/.well-known/caldav",
			});
		}
	);

	test.each(Object.keys(BY_DISCOVERY))(
		"%s refuses a principal href on another origin, even when a later candidate answers",
		async (name) => {
			const other = await elsewhere();
			// `/dav/cal` names a principal elsewhere; the fallback root `/` names a
			// working one. tsdav would settle for the fallback without a word.
			const stalwart: Loopback = await listen((req) => {
				if (req.url === "/.well-known/caldav") {
					return { headers: { location: "/dav/cal" }, status: 307 };
				}
				if (req.url === "/dav/cal") {
					return multistatus(
						propstat(
							"/dav/cal",
							`<d:current-user-principal><d:href>${other.origin}/dav/pal/u/</d:href></d:current-user-principal>`
						)
					);
				}
				if (req.url === "/") {
					return multistatus(
						propstat(
							"/",
							"<d:current-user-principal><d:href>/dav/pal/u/</d:href></d:current-user-principal>"
						)
					);
				}
				if (req.url === "/dav/pal/u/") {
					return multistatus(
						propstat(
							"/dav/pal/u/",
							"<c:calendar-home-set><d:href>/dav/cal/u/</d:href></c:calendar-home-set><c:calendar-user-address-set><d:href>mailto:user@example.com</d:href></c:calendar-user-address-set>"
						)
					);
				}
				return multistatus("");
			});
			const err = await BY_DISCOVERY[name]?.({
				serverUrl: stalwart.origin,
			}).catch((error: unknown) => error);
			expect(err).toBeInstanceOf(OriginMismatchError);
			expect(other.seen).toEqual([]);
		}
	);

	test("discovery follows Stalwart's relative well-known redirect", async () => {
		const stalwart: Loopback = await listen((req) => {
			if (req.url === "/.well-known/caldav") {
				return { headers: { location: "/dav/cal" }, status: 307 };
			}
			if (req.url === "/dav/cal") {
				return multistatus(
					propstat(
						"/dav/cal",
						"<d:current-user-principal><d:href>/dav/pal/u/</d:href></d:current-user-principal>"
					)
				);
			}
			if (req.url === "/dav/pal/u/") {
				return multistatus(
					propstat(
						"/dav/pal/u/",
						"<c:calendar-home-set><d:href>/dav/cal/u/</d:href></c:calendar-home-set>"
					)
				);
			}
			return multistatus(
				propstat(
					"/dav/cal/u/default/",
					'<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Calendar</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'
				)
			);
		});
		const calendars = await client.fetchCalendarList(
			{ serverUrl: stalwart.origin },
			CREDENTIAL
		);
		expect(calendars).toEqual([
			{ displayName: "Calendar", url: `${stalwart.origin}/dav/cal/u/default/` },
		]);
		expect(stalwart.seen.every((r) => r.authorization === CREDENTIAL)).toBe(
			true
		);
	});
});
