// Proves the HTTP transport's bearer token against the built server, started
// as a user would start it (`node dist/index.js --http`) and pointed at a
// live Stalwart account: with the token the MCP handshake succeeds and the
// server can be used; without it, or with a wrong one, every request gets a
// 401 and no data. The stdio transport is started the same way, so both ways
// of running the server are known to come up.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	createAccount,
	destroyCreatedAccounts,
	type TestAccount,
} from "./support/admin.ts";
import { live } from "./support/env.ts";
import {
	type HttpServer,
	startHttpServer,
	startStdioServer,
} from "./support/server.ts";

const SERVER_NAME = "langmail-mcp";
const UNAUTHORIZED_BODY = '{"error":"unauthorized"}\n';

const rpc = (method: string, params: unknown = {}): string =>
	JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });

const INITIALIZE = rpc("initialize", {
	capabilities: {},
	clientInfo: { name: "raw", version: "0" },
	protocolVersion: "2025-06-18",
});

live("the HTTP transport's bearer token", () => {
	const run = Date.now();
	let account: TestAccount;
	let server: HttpServer;

	beforeAll(async () => {
		account = await createAccount({ localPart: `http-auth-${run}` });
		server = await startHttpServer(account, { env: { LOG_LEVEL: "info" } });
	});

	afterAll(async () => {
		await server?.stop();
		await destroyCreatedAccounts();
	});

	const post = (
		body: string,
		headers: Record<string, string> = {},
		path = "/mcp"
	): Promise<Response> =>
		fetch(`${server.baseUrl}${path}`, {
			body,
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				...headers,
			},
			method: "POST",
		});

	// What a refused caller may learn: that a bearer token is wanted.
	const expectNoData = async (res: Response): Promise<void> => {
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe("Bearer");
		const body = await res.text();
		expect(body).toBe(UNAUTHORIZED_BODY);
		const everything = body + JSON.stringify([...res.headers]);
		expect(everything).not.toContain(SERVER_NAME);
		expect(everything).not.toContain(account.address);
		expect(everything).not.toContain("jsonrpc");
		expect(everything.toLowerCase()).not.toContain("stalwart");
	};

	test("with the right token the handshake succeeds and the server answers", async () => {
		expect(server.client.getServerVersion()?.name).toBe(SERVER_NAME);
		// A request after the handshake, on the same client.
		await expect(server.client.ping()).resolves.toBeDefined();
		// A second client, connected on its own.
		const another = await server.connect();
		expect(another.getServerVersion()?.name).toBe(SERVER_NAME);
		await expect(another.ping()).resolves.toBeDefined();
	});

	test("the SDK client is refused without a token and with a wrong one", async () => {
		await expect(server.connect(null)).rejects.toThrow();
		await expect(
			server.connect("not-the-right-token-at-all")
		).rejects.toThrow();
		// Same length as the real one, one character off.
		const last = server.token.at(-1) === "0" ? "1" : "0";
		await expect(
			server.connect(server.token.slice(0, -1) + last)
		).rejects.toThrow();
	});

	test.each([
		["initialize", INITIALIZE],
		["tools/list", rpc("tools/list")],
		["tools/call", rpc("tools/call", { arguments: {}, name: "search_emails" })],
		["resources/list", rpc("resources/list")],
		["ping", rpc("ping")],
	])("%s without a token gets 401 and no data", async (_, body) => {
		await expectNoData(await post(body));
	});

	test.each([
		["a wrong token", () => "Bearer not-the-right-token-at-all"],
		["a prefix of the token", () => `Bearer ${server.token.slice(0, 20)}`],
		["the token with one more character", () => `Bearer ${server.token}0`],
		["the token under another scheme", () => `Basic ${server.token}`],
		[
			"the token as a Basic password",
			() => `Basic ${Buffer.from(`user:${server.token}`).toString("base64")}`,
		],
		["the mailbox's own credential", () => account.authorization],
		["the bare token", () => server.token],
	])("%s gets 401 and no data", async (_, authorization) => {
		for (const body of [INITIALIZE, rpc("tools/list")]) {
			await expectNoData(await post(body, { authorization: authorization() }));
		}
	});

	test("the token in the URL or in another header is not accepted", async () => {
		await expectNoData(
			await post(INITIALIZE, {}, `/mcp?token=${server.token}`)
		);
		await expectNoData(
			await post(INITIALIZE, {}, `/mcp?access_token=${server.token}`)
		);
		await expectNoData(await post(INITIALIZE, { "x-api-key": server.token }));
	});

	test("GET and DELETE without a token are refused the same way", async () => {
		for (const method of ["GET", "DELETE"]) {
			await expectNoData(await fetch(server.mcpUrl, { method }));
		}
	});

	test("with the token, a raw initialize names the server", async () => {
		const res = await post(INITIALIZE, {
			authorization: `Bearer ${server.token}`,
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain(`"name":"${SERVER_NAME}"`);
	});

	test("there are no OAuth discovery documents; /healthz says ok and nothing else", async () => {
		for (const path of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-authorization-server",
			"/",
		]) {
			const res = await fetch(`${server.baseUrl}${path}`);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
		}
		const health = await fetch(`${server.baseUrl}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok\n");
	});

	test("a request from a web page's origin is refused, token or not", async () => {
		const res = await post(INITIALIZE, {
			authorization: `Bearer ${server.token}`,
			origin: "https://attacker.example.com",
		});
		expect(res.status).toBe(403);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		expect(await res.text()).toBe('{"error":"forbidden"}\n');
	});

	test("the log has a line per /mcp request and never the token or the app password", () => {
		const log = server.stderr();
		expect(log).toContain(`listening on ${server.mcpUrl}`);
		expect(log).toContain('"status":401');
		expect(log).toContain('"status":200');
		expect(log).not.toContain(server.token);
		expect(log).not.toContain(account.secret);
		expect(log).not.toContain(account.authorization);
		expect(log.toLowerCase()).not.toContain("authorization");
	});

	test("SIGTERM stops the server cleanly, and it stops answering", async () => {
		const own = await startHttpServer(account);
		expect(await own.stop()).toBe(0);
		await expect(fetch(`${own.baseUrl}/healthz`)).rejects.toThrow();
	});
});

live("the stdio transport", () => {
	const run = Date.now();
	let account: TestAccount;

	beforeAll(async () => {
		account = await createAccount({ localPart: `stdio-${run}` });
	});

	afterAll(destroyCreatedAccounts);

	test("the built server completes the handshake over stdio and keeps stdout clean", async () => {
		const server = await startStdioServer(account, {
			env: { LOG_LEVEL: "info" },
		});
		try {
			expect(server.client.getServerVersion()?.name).toBe(SERVER_NAME);
			await expect(server.client.ping()).resolves.toBeDefined();
			expect(server.stderr()).not.toContain(account.secret);
		} finally {
			await server.stop();
		}
	});
});
