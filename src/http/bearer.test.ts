import { describe, expect, test } from "vitest";
import { createBearerGate } from "./bearer.ts";

const TOKEN = "correct-horse-battery-staple";
const gate = createBearerGate(TOKEN);

const request = (authorization?: string): Request =>
	new Request("http://127.0.0.1:8080/mcp", {
		headers: authorization === undefined ? {} : { authorization },
		method: "POST",
	});

const expectUnauthorized = async (res: Response | undefined): Promise<void> => {
	expect(res?.status).toBe(401);
	expect(res?.headers.get("www-authenticate")).toBe("Bearer");
	expect(res?.headers.get("cache-control")).toBe("no-store");
	expect(res?.headers.get("content-type")).toBe("application/json");
	// The whole answer: nothing about the server, its tools or its mail server.
	expect(await res?.text()).toBe('{"error":"unauthorized"}\n');
};

describe("createBearerGate", () => {
	test("the right token passes", () => {
		expect(gate(request(`Bearer ${TOKEN}`))).toBeUndefined();
	});

	test("the scheme is case-insensitive", () => {
		expect(gate(request(`bearer ${TOKEN}`))).toBeUndefined();
		expect(gate(request(`BEARER ${TOKEN}`))).toBeUndefined();
	});

	test("no Authorization header is a 401", async () => {
		await expectUnauthorized(gate(request()));
	});

	test.each([
		["another scheme", `Basic ${TOKEN}`],
		["Basic credentials that decode to the token", `Basic ${btoa(TOKEN)}`],
		["the bare token", TOKEN],
		["the scheme alone", "Bearer"],
		["the scheme and a space", "Bearer "],
		["an empty header", ""],
		["two tokens", `Bearer ${TOKEN} ${TOKEN}`],
		["no space after the scheme", `Bearer${TOKEN}`],
	])("a malformed header is a 401: %s", async (_, authorization) => {
		await expectUnauthorized(gate(request(authorization)));
	});

	test.each([
		["a wrong token of the same length", TOKEN.replace("correct", "corrupt")],
		["a shorter token", TOKEN.slice(0, -1)],
		["a prefix", TOKEN.slice(0, 4)],
		["a longer token", `${TOKEN}x`],
		["a much longer token", TOKEN.repeat(50)],
		["the token in another case", TOKEN.toUpperCase()],
	])("a wrong token is a 401: %s", async (_, token) => {
		await expectUnauthorized(gate(request(`Bearer ${token}`)));
	});

	test("every refusal is the same answer, whatever was wrong", async () => {
		const answers = await Promise.all(
			[undefined, "Basic abc", "Bearer nope", `Bearer ${TOKEN}x`].map(
				async (authorization) => {
					const res = gate(request(authorization));
					return JSON.stringify([
						res?.status,
						[...(res?.headers ?? [])],
						await res?.text(),
					]);
				}
			)
		);
		expect(new Set(answers).size).toBe(1);
	});

	test("the answer never echoes what was presented", async () => {
		const res = gate(request("Bearer some-guess-at-the-token"));
		const everything = JSON.stringify([
			[...(res?.headers ?? [])],
			await res?.text(),
		]);
		expect(everything).not.toContain("some-guess");
		expect(everything).not.toContain(TOKEN);
	});
});
