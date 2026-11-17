import { describe, expect, test } from "vitest";

import { createTicketStore, type TicketInput } from "./tickets.ts";

// 32 bytes → 43 unpadded base64url chars, URL-safe alphabet only.
const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;

const INPUT: TicketInput = {
	accountId: "acct",
	authorization: "Bearer tok",
	blobId: "Gd41d8cd",
	name: "invoice.pdf",
	type: "application/pdf",
};

describe("ticket store", () => {
	test("mint → lookup roundtrip returns the bound ticket", () => {
		const store = createTicketStore(() => 1000);
		const token = store.mint(INPUT);
		const ticket = store.lookup(token);
		expect(ticket).toMatchObject(INPUT);
		expect(ticket?.expiresAt).toBe(1000 + 24 * 60 * 60 * 1000);
	});

	test("tokens are base64url, 256-bit, and unique", () => {
		const store = createTicketStore();
		const tokens = new Set(
			Array.from({ length: 100 }, () => store.mint(INPUT))
		);
		expect(tokens.size).toBe(100);
		for (const token of tokens) {
			expect(token).toMatch(BASE64URL_TOKEN_RE);
		}
	});

	test("a ticket is reusable until expiry, then misses", () => {
		let now = 0;
		const store = createTicketStore(() => now);
		const token = store.mint(INPUT);
		now = 14 * 60 * 1000;
		expect(store.lookup(token)).not.toBeNull();
		// Reusable: a second lookup within the window still hits.
		expect(store.lookup(token)).not.toBeNull();
		now = 24 * 60 * 60 * 1000;
		expect(store.lookup(token)).toBeNull();
	});

	test("expired tickets are swept on mint", () => {
		let now = 0;
		const store = createTicketStore(() => now);
		const stale = store.mint(INPUT);
		now = 25 * 60 * 60 * 1000;
		store.mint(INPUT);
		// The stale entry is gone even if time were wound back (sweep, not filter).
		now = 0;
		expect(store.lookup(stale)).toBeNull();
	});

	test("unknown tokens miss", () => {
		const store = createTicketStore();
		expect(store.lookup("nope")).toBeNull();
	});
});
