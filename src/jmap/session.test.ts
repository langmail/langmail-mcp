import { describe, expect, test, vi } from "vitest";

import { authorizationHeader, fetchSession, JmapError } from "./session.ts";

const STALWART = "https://mail.example.com";

const withFetch = <T>(
	impl: (url: string, init?: RequestInit) => Promise<Response>,
	fn: () => Promise<T>
): Promise<T> => {
	const original = globalThis.fetch;
	globalThis.fetch = impl as unknown as typeof fetch;
	return fn().finally(() => {
		globalThis.fetch = original;
	});
};

describe("authorizationHeader", () => {
	test("returns a credential unchanged, whatever its scheme", () => {
		expect(authorizationHeader("Bearer tok")).toBe("Bearer tok");
		expect(authorizationHeader("Basic dXNlcjpwYXNz")).toBe(
			"Basic dXNlcjpwYXNz"
		);
	});
});

describe("fetchSession", () => {
	test("hits /.well-known/jmap forwarding the Authorization header verbatim", async () => {
		const f = vi.fn((url: string, init?: RequestInit) => {
			expect(url).toBe(`${STALWART}/.well-known/jmap`);
			expect((init?.headers as Record<string, string>)?.authorization).toBe(
				"Bearer tok"
			);
			return Promise.resolve(
				Response.json(
					{
						apiUrl: `${STALWART}/jmap/`,
						downloadUrl: `${STALWART}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
						primaryAccounts: {
							"urn:ietf:params:jmap:mail": "acct-1",
						},
						uploadUrl: `${STALWART}/jmap/upload/{accountId}/`,
					},
					{ status: 200 }
				)
			);
		});
		const s = await withFetch(f, () =>
			fetchSession(STALWART, authorizationHeader("Bearer tok"))
		);
		expect(s.apiUrl).toBe(`${STALWART}/jmap/`);
		expect(s.downloadUrl).toBe(
			`${STALWART}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`
		);
		expect(s.uploadUrl).toBe(`${STALWART}/jmap/upload/{accountId}/`);
		expect(s.primaryAccounts["urn:ietf:params:jmap:mail"]).toBe("acct-1");
		expect(s.username).toBeUndefined();
	});

	test("carries the session's username, and treats an empty one as absent", async () => {
		const sessionWith = (username: string) => () =>
			Promise.resolve(
				Response.json({
					apiUrl: `${STALWART}/jmap/`,
					downloadUrl: `${STALWART}/jmap/download/{accountId}/{blobId}/{name}`,
					primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
					uploadUrl: `${STALWART}/jmap/upload/{accountId}/`,
					username,
				})
			);
		const named = await withFetch(sessionWith("user@example.com"), () =>
			fetchSession(STALWART, "Basic dXNlcjpwYXNz")
		);
		expect(named.username).toBe("user@example.com");
		const anonymous = await withFetch(sessionWith(""), () =>
			fetchSession(STALWART, "Basic dXNlcjpwYXNz")
		);
		expect(anonymous).not.toHaveProperty("username");
	});

	test("rejects a session without downloadUrl as malformed", async () => {
		const f = vi.fn(() =>
			Promise.resolve(
				Response.json(
					{
						apiUrl: `${STALWART}/jmap/`,
						primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
						uploadUrl: `${STALWART}/jmap/upload/{accountId}/`,
					},
					{ status: 200 }
				)
			)
		);
		await withFetch(f, async () => {
			const err = await fetchSession(
				STALWART,
				authorizationHeader("Bearer tok")
			).catch((error) => error);
			expect(err).toBeInstanceOf(JmapError);
			expect((err as JmapError).message).toContain("malformed");
		});
	});

	test("throws JmapError on non-200", async () => {
		const f = vi.fn(() =>
			Promise.resolve(new Response("nope", { status: 401 }))
		);
		await withFetch(f, async () => {
			const err = await fetchSession(
				STALWART,
				authorizationHeader("Bearer tok")
			).catch((error) => error);
			expect(err).toBeInstanceOf(JmapError);
			expect((err as JmapError).status).toBe(401);
		});
	});
});
