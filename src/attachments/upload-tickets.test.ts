import { describe, expect, test } from "vitest";

import {
	createUploadTicketStore,
	type UploadTicketInput,
} from "./upload-tickets.ts";

const INPUT: UploadTicketInput = {
	accountId: "acct",
	authorization: "Bearer tok",
	filename: "Bescheid.pdf",
	type: "application/pdf",
};

describe("upload ticket store", () => {
	test("mint returns a token and its expiry, and lookup finds the bound ticket", () => {
		const store = createUploadTicketStore(() => 1000);
		const minted = store.mint(INPUT);
		expect(minted.expiresAt).toBe(1000 + 15 * 60 * 1000);
		expect(store.lookup(minted.token)).toMatchObject({
			...INPUT,
			expiresAt: minted.expiresAt,
		});
	});

	test("lookup does not spend a ticket, take does — once", () => {
		const store = createUploadTicketStore();
		const { token } = store.mint(INPUT);
		expect(store.lookup(token)).not.toBeNull();
		expect(store.take(token)).toMatchObject(INPUT);
		expect(store.take(token)).toBeNull();
		expect(store.lookup(token)).toBeNull();
	});

	test("an expired ticket misses on both lookup and take", () => {
		let now = 0;
		const store = createUploadTicketStore(() => now);
		const { token } = store.mint(INPUT);
		now = 15 * 60 * 1000;
		expect(store.lookup(token)).toBeNull();
		expect(store.take(token)).toBeNull();
	});
});
