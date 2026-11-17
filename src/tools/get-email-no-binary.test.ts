// What get_email does on a machine langmail ships no native binary for
// (musl libc, for example): the package's loader throws when it is first
// loaded. Its own file, because the mock replaces `langmail` for every import
// in the file's module graph.

import { describe, expect, test, vi } from "vitest";

import type { EmailDetailRecord } from "../jmap/index.ts";
import { logger } from "../logger.ts";
import { type GetEmailDeps, getEmail } from "./get-email.ts";

const loads = vi.hoisted(() => ({ count: 0 }));

// The error napi-rs's generated loader throws when no binding fits.
vi.mock("langmail", () => {
	loads.count += 1;
	throw new Error("Cannot find native binding.");
});

const email: EmailDetailRecord = {
	blobId: "Graw1",
	bodyValues: { "1": { value: "jmap fallback body" } },
	id: "e1",
	size: 4096,
	subject: "Hello",
	textBody: [{ partId: "1", type: "text/plain" }],
};

const deps = (downloads: string[]): GetEmailDeps => ({
	downloadRawMessage: (p) => {
		downloads.push(p.blobId);
		return Promise.resolve(
			new TextEncoder().encode("Subject: Hello\r\n\r\nraw message body\r\n")
		);
	},
	emailGetDetail: () => Promise.resolve([email]),
	resolveAccountId: () => Promise.resolve("acct"),
});

describe("get_email without a langmail binary", () => {
	test("the module loads, and the body falls back to the JMAP text body", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const downloads: string[] = [];
		try {
			const first = await getEmail(deps(downloads), {
				args: { id: "e1" },
				token: "Bearer tok",
			});
			const second = await getEmail(deps(downloads), {
				args: { id: "e1" },
				token: "Bearer tok",
			});

			for (const result of [first, second]) {
				expect(result.isError).toBeUndefined();
				const text = result.content[0]?.text ?? "";
				expect(text).toContain("Subject: Hello");
				expect(text).toContain("jmap fallback body");
				expect(text).not.toContain("raw message body");
			}
			// The raw path was attempted, so the failure is the missing binding.
			expect(downloads).toEqual(["Graw1", "Graw1"]);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(warn.mock.calls[0]?.[1]).toBe(
				"raw message preprocessing failed, falling back to jmap text body"
			);
			// The loader is not retried on every call.
			expect(loads.count).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});
});
