import { describe, expect, test, vi } from "vitest";

import { JmapError } from "./session.ts";
import {
	sieveScriptCreate,
	sieveScriptList,
	sieveScriptUpdate,
} from "./sieve.ts";

const API = "https://mail.example.com/jmap/";

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

const jmapResponse = (methodResponses: unknown[]) =>
	Response.json({ methodResponses }, { status: 200 });

describe("sieveScriptList", () => {
	test("sends SieveScript/get with ids:null under the sieve capability and parses the list", async () => {
		const f = vi.fn((url: string, init?: RequestInit) => {
			expect(url).toBe(API);
			const body = JSON.parse((init?.body as string) ?? "{}");
			expect(body.using).toContain("urn:ietf:params:jmap:sieve");
			expect(body.methodCalls[0][0]).toBe("SieveScript/get");
			expect(body.methodCalls[0][1]).toEqual({ accountId: "acct", ids: null });
			return Promise.resolve(
				jmapResponse([
					[
						"SieveScript/get",
						{
							list: [
								{
									blobId: "b1",
									id: "s1",
									isActive: true,
									name: "langmail-rules",
								},
							],
						},
						"0",
					],
				])
			);
		});
		const scripts = await withFetch(f, () =>
			sieveScriptList({
				accountId: "acct",
				apiUrl: API,
				authorization: "Bearer tok",
			})
		);
		expect(scripts).toEqual([
			{ blobId: "b1", id: "s1", isActive: true, name: "langmail-rules" },
		]);
	});

	test("returns [] when the account has no scripts", async () => {
		const f = vi.fn(() =>
			Promise.resolve(jmapResponse([["SieveScript/get", { list: [] }, "0"]]))
		);
		const scripts = await withFetch(f, () =>
			sieveScriptList({
				accountId: "acct",
				apiUrl: API,
				authorization: "Bearer tok",
			})
		);
		expect(scripts).toEqual([]);
	});
});

describe("sieveScriptCreate", () => {
	test("creates from a blob and activates via onSuccessActivateScript back-reference", async () => {
		const f = vi.fn((_u: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string) ?? "{}");
			const [name, args] = body.methodCalls[0];
			expect(name).toBe("SieveScript/set");
			expect(args.create.s0).toEqual({
				blobId: "blob-1",
				name: "langmail-rules",
			});
			expect(args.onSuccessActivateScript).toBe("#s0");
			return Promise.resolve(
				jmapResponse([
					["SieveScript/set", { created: { s0: { id: "script-9" } } }, "0"],
				])
			);
		});
		const id = await withFetch(f, () =>
			sieveScriptCreate({
				accountId: "acct",
				apiUrl: API,
				authorization: "Bearer tok",
				blobId: "blob-1",
				name: "langmail-rules",
			})
		);
		expect(id).toBe("script-9");
	});

	test("throws a JmapError naming the notCreated type", async () => {
		const f = vi.fn(() =>
			Promise.resolve(
				jmapResponse([
					[
						"SieveScript/set",
						{ notCreated: { s0: { type: "invalidScript" } } },
						"0",
					],
				])
			)
		);
		await withFetch(f, async () => {
			const err = await sieveScriptCreate({
				accountId: "acct",
				apiUrl: API,
				authorization: "Bearer tok",
				blobId: "blob-1",
				name: "langmail-rules",
			}).catch((error) => error);
			expect(err).toBeInstanceOf(JmapError);
			expect((err as JmapError).message).toContain("invalidScript");
		});
	});
});

describe("sieveScriptUpdate", () => {
	test("points the script at the new blob and re-activates it", async () => {
		const f = vi.fn((_u: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string) ?? "{}");
			const [name, args] = body.methodCalls[0];
			expect(name).toBe("SieveScript/set");
			expect(args.update["script-9"]).toEqual({ blobId: "blob-2" });
			expect(args.onSuccessActivateScript).toBe("script-9");
			return Promise.resolve(
				jmapResponse([
					["SieveScript/set", { updated: { "script-9": null } }, "0"],
				])
			);
		});
		await withFetch(f, () =>
			sieveScriptUpdate({
				accountId: "acct",
				apiUrl: API,
				authorization: "Bearer tok",
				blobId: "blob-2",
				scriptId: "script-9",
			})
		);
		expect(f).toHaveBeenCalled();
	});

	test("throws a JmapError naming the notUpdated type", async () => {
		const f = vi.fn(() =>
			Promise.resolve(
				jmapResponse([
					[
						"SieveScript/set",
						{ notUpdated: { "script-9": { type: "blobNotFound" } } },
						"0",
					],
				])
			)
		);
		await withFetch(f, async () => {
			const err = await sieveScriptUpdate({
				accountId: "acct",
				apiUrl: API,
				authorization: "Bearer tok",
				blobId: "blob-2",
				scriptId: "script-9",
			}).catch((error) => error);
			expect(err).toBeInstanceOf(JmapError);
			expect((err as JmapError).message).toContain("blobNotFound");
		});
	});
});
