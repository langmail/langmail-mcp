import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { createRequestGuard } from "../http/guard.ts";
import { createFetchHandler, healthRoute } from "../http/routes.ts";
import type { JmapLive } from "../jmap/index.ts";
import { logger } from "../logger.ts";
import { createRuntime, SERVER_NAME } from "./handler.ts";
import { mcpRoutes } from "./http.ts";

const BASE = "http://127.0.0.1:8080";
const TOKEN = "a-long-random-secret";
const STALWART_PASSWORD = "the-app-password";

const { config } = loadConfig(
	{
		MCP_AUTH_TOKEN: TOKEN,
		STALWART_PASSWORD,
		STALWART_URL: "https://mail.example.com",
		STALWART_USERNAME: "user@example.com",
	},
	["--http"]
);

// A mail server that must never be asked: nothing below calls a tool.
const getSession = vi.fn(() =>
	Promise.reject(new Error("Stalwart must not be contacted"))
);
const jmapLive = { getSession } as unknown as JmapLive;

const makeFetch = () =>
	createFetchHandler(
		[healthRoute, ...mcpRoutes(config, TOKEN, createRuntime(config, jmapLive))],
		{
			guard: createRequestGuard({ host: "127.0.0.1", publicUrl: BASE }),
		}
	);

const INITIALIZE = {
	id: 1,
	jsonrpc: "2.0",
	method: "initialize",
	params: {
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
		protocolVersion: "2025-06-18",
	},
};

const post = (body: unknown, authorization?: string, path = "/mcp"): Request =>
	new Request(`${BASE}${path}`, {
		body: JSON.stringify(body),
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			host: "127.0.0.1:8080",
			...(authorization === undefined ? {} : { authorization }),
		},
		method: "POST",
	});

// The transport answers a POST as a one-event stream; this reads the event.
const rpcResult = async (res: Response): Promise<Record<string, unknown>> => {
	const data = (await res.text())
		.split("\n")
		.find((line) => line.startsWith("data: "));
	return JSON.parse((data ?? "data: {}").slice("data: ".length));
};

afterEach(() => {
	vi.restoreAllMocks();
	getSession.mockClear();
});

describe("POST /mcp without the token", () => {
	test.each([
		["no Authorization header", undefined],
		["a wrong token", "Bearer not-the-right-secret"],
		["a token of another length", `Bearer ${TOKEN}x`],
		["another scheme", `Basic ${btoa(`user:${TOKEN}`)}`],
		["the bare token", TOKEN],
	])("%s gets 401 and no data", async (_, authorization) => {
		const req = post(INITIALIZE, authorization);
		const res = await makeFetch()(req);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe("Bearer");
		const body = await res.text();
		expect(body).toBe('{"error":"unauthorized"}\n');
		// Nothing about the server: no name, no version, no mail server.
		const everything = body + JSON.stringify([...res.headers]);
		expect(everything).not.toContain(SERVER_NAME);
		expect(everything).not.toContain("mail.example.com");
		expect(everything).not.toContain("jsonrpc");
		// The body was never read, let alone parsed.
		expect(req.bodyUsed).toBe(false);
		expect(getSession).not.toHaveBeenCalled();
	});

	test.each(["GET", "DELETE", "PUT", "OPTIONS"])(
		"%s without the token is a 401 too, not a 405",
		async (method) => {
			const res = await makeFetch()(
				new Request(`${BASE}/mcp`, {
					headers: { host: "127.0.0.1:8080" },
					method,
				})
			);
			expect(res.status).toBe(401);
			expect(res.headers.get("allow")).toBeNull();
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}
	);

	test("a tools/list or tools/call without the token is refused the same way", async () => {
		for (const method of ["tools/list", "tools/call"]) {
			const res = await makeFetch()(
				post({ id: 2, jsonrpc: "2.0", method, params: {} })
			);
			expect(res.status).toBe(401);
			expect(await res.text()).toBe('{"error":"unauthorized"}\n');
		}
	});
});

describe("POST /mcp with the token", () => {
	test("initialize succeeds and names the server, without contacting Stalwart", async () => {
		const res = await makeFetch()(post(INITIALIZE, `Bearer ${TOKEN}`));
		expect(res.status).toBe(200);
		const message = await rpcResult(res);
		expect(message.id).toBe(1);
		expect(
			(message.result as { serverInfo: { name: string } }).serverInfo.name
		).toBe(SERVER_NAME);
		expect(getSession).not.toHaveBeenCalled();
	});

	test("the scheme may be lowercase", async () => {
		const res = await makeFetch()(post(INITIALIZE, `bearer ${TOKEN}`));
		expect(res.status).toBe(200);
	});

	test("every request stands alone: a ping needs no initialize before it and no session", async () => {
		const fetch = makeFetch();
		const res = await fetch(
			post({ id: 7, jsonrpc: "2.0", method: "ping" }, `Bearer ${TOKEN}`)
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("mcp-session-id")).toBeNull();
		expect(await rpcResult(res)).toEqual({ id: 7, jsonrpc: "2.0", result: {} });
	});

	test("a notification is accepted with 202 and no body", async () => {
		const res = await makeFetch()(
			post(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				`Bearer ${TOKEN}`
			)
		);
		expect(res.status).toBe(202);
		expect(await res.text()).toBe("");
	});

	test("/mcp/<anything> is the same endpoint", async () => {
		const res = await makeFetch()(
			post(INITIALIZE, `Bearer ${TOKEN}`, "/mcp/anything")
		);
		expect(res.status).toBe(200);
		expect(
			(await makeFetch()(post(INITIALIZE, undefined, "/mcp/x"))).status
		).toBe(401);
	});

	test("a body that is not JSON is a 400 parse error", async () => {
		const res = await makeFetch()(
			new Request(`${BASE}/mcp`, {
				body: "{not json",
				headers: {
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
					host: "127.0.0.1:8080",
				},
				method: "POST",
			})
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-32_700
		);
	});

	test.each(["GET", "DELETE", "PUT"])(
		"%s is 405: a stateless server has no stream to open and no session to end",
		async (method) => {
			const res = await makeFetch()(
				new Request(`${BASE}/mcp`, {
					headers: {
						accept: "text/event-stream",
						authorization: `Bearer ${TOKEN}`,
						host: "127.0.0.1:8080",
					},
					method,
				})
			);
			expect(res.status).toBe(405);
			expect(res.headers.get("allow")).toBe("POST");
		}
	);
});

describe("everything else on the listener", () => {
	test("there are no OAuth discovery documents and no readiness probe", async () => {
		for (const path of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-protected-resource/mcp",
			"/readyz",
			"/",
			"/mcpx",
		]) {
			const res = await makeFetch()(
				new Request(`${BASE}${path}`, {
					headers: {
						authorization: `Bearer ${TOKEN}`,
						host: "127.0.0.1:8080",
					},
				})
			);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
		}
	});

	test("GET /healthz answers ok without the token", async () => {
		const res = await makeFetch()(
			new Request(`${BASE}/healthz`, { headers: { host: "127.0.0.1:8080" } })
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok\n");
	});

	test("a request from a web page is refused before the token is looked at", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const req = post(INITIALIZE, `Bearer ${TOKEN}`);
		req.headers.set("origin", "https://attacker.example.com");
		const res = await makeFetch()(req);
		expect(res.status).toBe(403);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("a request under a rebound hostname is refused", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const req = post(INITIALIZE, `Bearer ${TOKEN}`);
		req.headers.set("host", "attacker.example.com:8080");
		expect((await makeFetch()(req)).status).toBe(403);
	});
});

describe("/mcp request logging", () => {
	const loggedBy = async (
		fn: () => Promise<unknown>
	): Promise<{ lines: Record<string, unknown>[]; everything: string }> => {
		const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
			vi.spyOn(logger, level).mockImplementation(() => undefined)
		);
		await fn();
		const calls = spies.flatMap((spy) => spy.mock.calls);
		return {
			everything: JSON.stringify(calls),
			lines: calls
				.filter(([, msg]) => msg === "mcp request")
				.map(([fields]) => fields as unknown as Record<string, unknown>),
		};
	};

	test("records method, route, status and duration for an authenticated request", async () => {
		const { everything, lines } = await loggedBy(() =>
			makeFetch()(post(INITIALIZE, `Bearer ${TOKEN}`))
		);
		expect(lines).toHaveLength(1);
		const [line] = lines;
		expect(line?.method).toBe("POST");
		expect(line?.route).toBe("/mcp");
		expect(line?.status).toBe(200);
		expect(typeof line?.durationMs).toBe("number");
		// Neither secret reaches any log line, nor does the mailbox address.
		expect(everything).not.toContain(TOKEN);
		expect(everything).not.toContain(STALWART_PASSWORD);
		expect(everything).not.toContain(config.credential);
		expect(everything).not.toContain("user@example.com");
	});

	test("records a rejected request too — a 401 is an outcome, not a non-event", async () => {
		const { everything, lines } = await loggedBy(() =>
			makeFetch()(post(INITIALIZE, "Bearer a-guess-at-the-secret"))
		);
		expect(lines[0]?.status).toBe(401);
		expect(lines[0]?.route).toBe("/mcp");
		// What the caller presented is not logged either.
		expect(everything).not.toContain("a-guess-at-the-secret");
		expect(everything).not.toContain(TOKEN);
	});

	test("leaves health and unknown routes unlogged", async () => {
		const fetch = makeFetch();
		const { lines } = await loggedBy(async () => {
			await fetch(
				new Request(`${BASE}/healthz`, { headers: { host: "127.0.0.1:8080" } })
			);
			await fetch(
				new Request(`${BASE}/.well-known/oauth-protected-resource`, {
					headers: { host: "127.0.0.1:8080" },
				})
			);
		});
		expect(lines).toHaveLength(0);
	});
});
