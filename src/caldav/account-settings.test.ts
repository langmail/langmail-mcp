import { afterEach, describe, expect, test } from "vitest";

import { makeAccountTimeZoneResolver } from "./account-settings.ts";

const SERVER = "https://mail.example.test";
const API_URL = `${SERVER}/jmap/`;

// A JMAP session resource with a mail primary account, as fetchSession expects.
const sessionBody = {
	apiUrl: API_URL,
	downloadUrl: `${SERVER}/download/{accountId}/{blobId}/{name}/{type}`,
	primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
	uploadUrl: `${SERVER}/upload/{accountId}/`,
};

const accountSettingsBody = (timeZone: unknown): unknown => ({
	methodResponses: [
		[
			"x:AccountSettings/get",
			{ list: [timeZone === undefined ? {} : { timeZone }] },
			"0",
		],
	],
});

interface StubCall {
	method: string;
	url: string;
}

// Installs a fetch stub that answers the session GET and the settings POST from
// `settings`, recording every request so caching can be asserted. Returns the
// call log.
const installFetch = (
	settings: () => { body?: unknown; status?: number }
): StubCall[] => {
	const calls: StubCall[] = [];
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		calls.push({ method, url });
		if (url.endsWith("/.well-known/jmap")) {
			return Promise.resolve(
				new Response(JSON.stringify(sessionBody), { status: 200 })
			);
		}
		const { body, status = 200 } = settings();
		return Promise.resolve(
			new Response(body === undefined ? "" : JSON.stringify(body), { status })
		);
	}) as typeof fetch;
	return calls;
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("makeAccountTimeZoneResolver", () => {
	test("returns the stored IANA zone", async () => {
		installFetch(() => ({ body: accountSettingsBody("Europe/Berlin") }));
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER });
		expect(await resolve("tok")).toBe("Europe/Berlin");
	});

	test("caches the result per token (no repeat round-trips)", async () => {
		const calls = installFetch(() => ({
			body: accountSettingsBody("America/New_York"),
		}));
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER });
		expect(await resolve("tok")).toBe("America/New_York");
		expect(await resolve("tok")).toBe("America/New_York");
		// One session GET + one settings POST, not two of each.
		expect(calls).toHaveLength(2);
	});

	test("returns null when the preference is unset", async () => {
		installFetch(() => ({ body: accountSettingsBody(undefined) }));
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER });
		expect(await resolve("tok")).toBeNull();
	});

	test("returns null for a zone the runtime does not recognize", async () => {
		installFetch(() => ({ body: accountSettingsBody("Middle/Earth") }));
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER });
		expect(await resolve("tok")).toBeNull();
	});

	test("fails open to null on an error method response", async () => {
		installFetch(() => ({
			body: { methodResponses: [["error", { type: "forbidden" }, "0"]] },
		}));
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER });
		expect(await resolve("tok")).toBeNull();
	});

	test("fails open to null when the settings POST is non-200", async () => {
		installFetch(() => ({ status: 403 }));
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER });
		expect(await resolve("tok")).toBeNull();
	});

	test("re-reads after the cache TTL expires", async () => {
		let zone = "Europe/Berlin";
		const calls = installFetch(() => ({ body: accountSettingsBody(zone) }));
		// Zero TTL: every call is a miss, so a changed preference is picked up.
		const resolve = makeAccountTimeZoneResolver({ serverUrl: SERVER }, 0);
		expect(await resolve("tok")).toBe("Europe/Berlin");
		zone = "America/New_York";
		expect(await resolve("tok")).toBe("America/New_York");
		expect(calls.length).toBe(4);
	});
});
