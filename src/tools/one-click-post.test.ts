import { describe, expect, test } from "vitest";

import {
	BlockedAddressError,
	guardedLookup,
	type HopResponse,
	isBlockedAddress,
	makeSendHop,
	postOneClick,
	type SendHop,
} from "./one-click-post.ts";

describe("isBlockedAddress", () => {
	test.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.20.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"::1",
		"::",
		"fe80::1",
		"fd00::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"64:ff9b::a00:1",
		"64:ff9b:1::1",
		"::7f00:1",
		"::ffff:7f00:1",
		"::ffff:a9fe:a9fe",
		"2001:0:4136::1",
		"2002:a00:1::1",
		"not-an-ip",
	])("blocks %s", (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	test.each([
		"93.184.215.14",
		"1.1.1.1",
		"2606:4700:4700::1111",
		"::ffff:1.1.1.1",
	])("allows %s", (address) => {
		expect(isBlockedAddress(address)).toBe(false);
	});
});

describe("guardedLookup", () => {
	const run = (
		addresses: { address: string; family: number }[],
		all: boolean
	) =>
		new Promise<{ err: Error | null; result: unknown }>((resolve) => {
			guardedLookup(() => Promise.resolve(addresses))(
				"news.example.com",
				{ all },
				(err, result) => resolve({ err, result })
			);
		});

	test("refuses a name with any internal address, even beside a public one", async () => {
		const { err } = await run(
			[
				{ address: "93.184.215.14", family: 4 },
				{ address: "10.0.0.5", family: 4 },
			],
			true
		);
		expect(err).toBeInstanceOf(BlockedAddressError);
	});

	test("hands public addresses through in the shape asked for", async () => {
		const addresses = [{ address: "93.184.215.14", family: 4 }];
		expect((await run(addresses, true)).result).toEqual(addresses);
		expect((await run(addresses, false)).result).toBe("93.184.215.14");
	});
});

describe("makeSendHop", () => {
	test("a host that resolves to loopback is refused before any connection", async () => {
		const hop = makeSendHop(() =>
			Promise.resolve([{ address: "127.0.0.1", family: 4 }])
		);
		expect(await postOneClick("https://rebind.example.com/u", hop)).toEqual({
			kind: "refused",
			reason: "rebind.example.com resolves to a private or internal address",
		});
	});
});

const scripted = (responses: Record<string, HopResponse | Error>) => {
	const calls: [string, string][] = [];
	const hop: SendHop = (url, method) => {
		calls.push([url, method]);
		const r = responses[url];
		if (!r) {
			return Promise.reject(new Error(`unexpected ${url}`));
		}
		return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
	};
	return { calls, hop };
};

describe("postOneClick", () => {
	test("POSTs once and returns the response", async () => {
		const { calls, hop } = scripted({
			"https://news.example.com/u": { body: "ok", location: null, status: 202 },
		});
		expect(await postOneClick("https://news.example.com/u", hop)).toEqual({
			body: "ok",
			host: "news.example.com",
			kind: "response",
			redirected: false,
			status: 202,
		});
		expect(calls).toEqual([["https://news.example.com/u", "POST"]]);
	});

	test("refuses a non-https link without calling it", async () => {
		const { calls, hop } = scripted({});
		expect(await postOneClick("http://news.example.com/u", hop)).toEqual({
			kind: "refused",
			reason: "the link is not https",
		});
		expect(calls).toEqual([]);
	});

	test("307 repeats the POST, 302 turns into a GET", async () => {
		const { calls, hop } = scripted({
			"https://a.example.com/u": {
				body: "",
				location: "https://b.example.com/u",
				status: 307,
			},
			"https://b.example.com/u": { body: "", location: "/done", status: 302 },
			"https://b.example.com/done": {
				body: "Bye",
				location: null,
				status: 200,
			},
		});
		const out = await postOneClick("https://a.example.com/u", hop);
		expect(out).toMatchObject({
			host: "b.example.com",
			kind: "response",
			redirected: true,
			status: 200,
		});
		expect(calls).toEqual([
			["https://a.example.com/u", "POST"],
			["https://b.example.com/u", "POST"],
			["https://b.example.com/done", "GET"],
		]);
	});

	test("a redirect to http is not followed, and the sender already has the request", async () => {
		const { hop } = scripted({
			"https://a.example.com/u": {
				body: "",
				location: "http://a.example.com/u",
				status: 301,
			},
		});
		expect(await postOneClick("https://a.example.com/u", hop)).toEqual({
			kind: "failed",
			reachedSender: true,
			reason:
				"the sender redirected to a non-https address (http:), so Langmail did not follow it",
		});
	});

	test("a redirect into an internal address is not followed, and the sender already has the request", async () => {
		const { hop } = scripted({
			"https://a.example.com/u": {
				body: "",
				location: "https://internal.example.com/x",
				status: 307,
			},
			"https://internal.example.com/x": new BlockedAddressError(
				"internal.example.com"
			),
		});
		expect(await postOneClick("https://a.example.com/u", hop)).toEqual({
			kind: "failed",
			reachedSender: true,
			reason:
				"internal.example.com resolves to a private or internal address, so Langmail did not follow it",
		});
	});

	test("a network error is reported as failed", async () => {
		const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:6379"), {
			code: "ECONNREFUSED",
		});
		const { hop } = scripted({ "https://a.example.com/u": err });
		// The dialled address and port stay out of the result.
		expect(await postOneClick("https://a.example.com/u", hop)).toEqual({
			kind: "failed",
			reachedSender: false,
			reason: "the connection failed",
		});
	});

	test.each([
		"https://127.0.0.1/u",
		"https://169.254.169.254/latest",
		"https://[::1]/u",
		"https://[::ffff:127.0.0.1]/u",
		"https://2130706433/u",
	])("refuses the IP literal %s without calling it", async (url) => {
		const { calls, hop } = scripted({});
		const out = await postOneClick(url, hop);
		expect(out.kind).toBe("refused");
		expect(calls).toEqual([]);
	});

	test("a redirect to an internal IP literal is not followed", async () => {
		const { calls, hop } = scripted({
			"https://a.example.com/u": {
				body: "",
				location: "https://10.0.0.5/x",
				status: 307,
			},
		});
		expect(await postOneClick("https://a.example.com/u", hop)).toMatchObject({
			kind: "failed",
			reachedSender: true,
		});
		expect(calls).toHaveLength(1);
	});

	test("a malformed Location is a failure, not a throw", async () => {
		const { hop } = scripted({
			"https://a.example.com/u": {
				body: "",
				location: "https://[bad",
				status: 302,
			},
		});
		expect(await postOneClick("https://a.example.com/u", hop)).toEqual({
			kind: "failed",
			reachedSender: true,
			reason: "the sender redirected to an invalid address",
		});
	});

	test("stops after three redirects", async () => {
		const { hop } = scripted({
			"https://a.example.com/1": { body: "", location: "/2", status: 307 },
			"https://a.example.com/2": { body: "", location: "/3", status: 307 },
			"https://a.example.com/3": { body: "", location: "/4", status: 307 },
			"https://a.example.com/4": { body: "", location: "/5", status: 307 },
		});
		expect(await postOneClick("https://a.example.com/1", hop)).toEqual({
			kind: "failed",
			reachedSender: true,
			reason: "the sender redirected more than 3 times",
		});
	});
});
