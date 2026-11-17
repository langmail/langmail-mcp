import { describe, expect, test } from "vitest";

import type { JmapLive } from "../jmap/index.ts";

import { makeAttendeeWriteThrough } from "./contact-write-through.ts";

const input = {
	attendees: [{ email: "robin@northwind.example" }],
	organizer: "me@example.com",
	selfAddress: "me@example.com",
	start: "2026-07-28T12:00:00Z",
	token: "tok",
	uid: "evt-1@example.com",
};

// The load-bearing promise of the hook: the calendar tools await it bare
// after a successful CalDAV write, so it must absorb every failure — a
// contact upsert can never fail a scheduling action.
describe("makeAttendeeWriteThrough", () => {
	test("resolves when the JMAP session lookup fails", async () => {
		const live: JmapLive = {
			getSession: () => Promise.reject(new Error("stalwart down")),
			resolveAccountId: () => Promise.reject(new Error("stalwart down")),
		};
		expect(await makeAttendeeWriteThrough(live)(input)).toBeUndefined();
	});

	test("resolves when the session is malformed (no contacts or mail account)", async () => {
		const live: JmapLive = {
			getSession: () =>
				Promise.resolve({
					apiUrl: "https://mail.example.com/jmap/",
					downloadUrl: "",
					primaryAccounts: {},
					uploadUrl: "",
				}),
			resolveAccountId: () => Promise.resolve("acct"),
		};
		expect(await makeAttendeeWriteThrough(live)(input)).toBeUndefined();
	});

	test("resolves when the contacts JMAP calls fail", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.reject(new Error("network down"))) as unknown as typeof fetch;
		const live: JmapLive = {
			getSession: () =>
				Promise.resolve({
					apiUrl: "https://mail.example.com/jmap/",
					downloadUrl: "",
					primaryAccounts: { "urn:ietf:params:jmap:mail": "acct" },
					uploadUrl: "",
				}),
			resolveAccountId: () => Promise.resolve("acct"),
		};
		try {
			expect(await makeAttendeeWriteThrough(live)(input)).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
