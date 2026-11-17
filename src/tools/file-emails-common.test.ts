import { describe, expect, test } from "vitest";

import { formatBatchResult, idsInput } from "./file-emails-common.ts";

describe("idsInput", () => {
	test("accepts 1..50 ids and rejects an empty list", () => {
		expect(idsInput.safeParse({ ids: ["m1"] }).success).toBe(true);
		expect(idsInput.safeParse({ ids: [] }).success).toBe(false);
		expect(
			idsInput.safeParse({ ids: Array.from({ length: 50 }, (_, i) => `m${i}`) })
				.success
		).toBe(true);
		expect(
			idsInput.safeParse({ ids: Array.from({ length: 51 }, (_, i) => `m${i}`) })
				.success
		).toBe(false);
	});

	test("rejects an empty id", () => {
		expect(idsInput.safeParse({ ids: [""] }).success).toBe(false);
	});

	test("collapses duplicate ids, keeping first-seen order", () => {
		expect(idsInput.parse({ ids: ["m2", "m1", "m2"] }).ids).toEqual([
			"m2",
			"m1",
		]);
	});
});

describe("formatBatchResult", () => {
	test("reports a clean batch as a plain count", () => {
		const result = formatBatchResult("Archived", {
			notUpdated: [],
			updated: ["m1", "m2"],
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toBe("Archived 2 message(s).");
	});

	test("lists failed ids with their reason and keeps success when some updated", () => {
		const result = formatBatchResult(
			"Moved",
			{ notUpdated: [{ id: "m2", type: "notFound" }], updated: ["m1"] },
			" to Projects"
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain(
			"Moved 1 message(s) to Projects."
		);
		expect(result.content[0]?.text).toContain("Not updated (1): m2 (notFound)");
	});

	test("is an error when nothing was updated", () => {
		const result = formatBatchResult("Trashed", {
			notUpdated: [{ id: "m1", type: "notFound" }],
			updated: [],
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Trashed 0 message(s).");
		expect(result.content[0]?.text).toContain("m1 (notFound)");
		expect(result.content[0]?.text).toContain("search_emails or get_thread");
	});
});
