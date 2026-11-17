import {
	InMemoryTransport,
	type JSONRPCMessage,
	type McpServer,
} from "@modelcontextprotocol/server";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../config.ts";
import { JmapError, type JmapLive, type JmapSession } from "../jmap/index.ts";
import { logger } from "../logger.ts";
import {
	createRuntime,
	createServer,
	readPackageVersion,
	SERVER_NAME,
} from "./handler.ts";

const SEMVER = /^\d+\.\d+\.\d+/u;
const CREDENTIAL = "Basic dXNlckBleGFtcGxlLmNvbTpzZWNyZXQ=";

const config: Config = {
	allowRemoteImages: false,
	allowUnsubscribePost: false,
	credential: CREDENTIAL,
	stalwartUrl: "https://mail.example.com",
	transport: { kind: "stdio" },
};

const session = (username?: string): JmapSession => ({
	apiUrl: "https://mail.example.com/jmap/",
	downloadUrl: "https://mail.example.com/jmap/download/",
	primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
	uploadUrl: "https://mail.example.com/jmap/upload/",
	...(username === undefined ? {} : { username }),
});

// A JmapLive whose session lookup is scripted and counted; nothing is dialled.
const fakeLive = (
	getSession: (authorization: string) => Promise<JmapSession>
): JmapLive & { seen: string[] } => {
	const seen: string[] = [];
	return {
		getSession: (authorization) => {
			seen.push(authorization);
			return getSession(authorization);
		},
		resolveAccountId: () => Promise.resolve("acct-1"),
		seen,
	};
};

interface RpcResult {
	content?: { text: string; type: string }[];
	isError?: boolean;
	[key: string]: unknown;
}

// Drives a server over an in-memory transport the way a client would.
const connect = async (
	server: McpServer
): Promise<{
	close: () => Promise<void>;
	request: (
		method: string,
		params?: Record<string, unknown>
	) => Promise<RpcResult>;
}> => {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const waiting = new Map<number, (message: JSONRPCMessage) => void>();
	clientSide.onmessage = (message) => {
		const id = (message as { id?: number }).id;
		if (id !== undefined) {
			waiting.get(id)?.(message);
		}
	};
	await clientSide.start();
	let nextId = 0;
	const request = async (
		method: string,
		params: Record<string, unknown> = {}
	): Promise<RpcResult> => {
		nextId += 1;
		const id = nextId;
		const reply = new Promise<JSONRPCMessage>((resolve) => {
			waiting.set(id, resolve);
		});
		await clientSide.send({ id, jsonrpc: "2.0", method, params });
		const message = (await reply) as {
			error?: { message: string };
			result?: RpcResult;
		};
		if (!message.result) {
			throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
		}
		return message.result;
	};
	await request("initialize", {
		capabilities: {},
		clientInfo: { name: "test-client", version: "0.0.0" },
		protocolVersion: "2025-06-18",
	});
	await clientSide.send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	return { close: () => server.close(), request };
};

const textOf = (result: RpcResult): string =>
	result.content?.map((part) => part.text).join("\n") ?? "";

// A tool that reports what the runtime hands a tool, registered the way the
// real ones are: after createServer has instrumented the server.
const registerWhoami = (
	server: McpServer,
	getToken: () => string,
	getPrincipal: () => string
): void => {
	server.registerTool(
		"whoami",
		{ description: "Reports the caller.", inputSchema: z.object({}) },
		() => ({
			content: [{ text: `${getPrincipal()} ${getToken()}`, type: "text" }],
		})
	);
};

const quietly = async (fn: () => Promise<void>): Promise<void> => {
	const spies = (["info", "warn", "error"] as const).map((level) =>
		vi.spyOn(logger, level).mockImplementation(() => undefined)
	);
	try {
		await fn();
	} finally {
		for (const spy of spies) {
			spy.mockRestore();
		}
	}
};

describe("createServer", () => {
	test("answers initialize with the server's name and package version", async () => {
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const server = createServer(config);
		await server.connect(serverSide);

		const reply = new Promise<JSONRPCMessage>((resolve) => {
			clientSide.onmessage = resolve;
		});
		await clientSide.start();
		await clientSide.send({
			id: 1,
			jsonrpc: "2.0",
			method: "initialize",
			params: {
				capabilities: {},
				clientInfo: { name: "test-client", version: "0.0.0" },
				protocolVersion: "2025-06-18",
			},
		});

		expect(await reply).toMatchObject({
			id: 1,
			result: {
				protocolVersion: "2025-06-18",
				serverInfo: { name: SERVER_NAME, version: readPackageVersion() },
			},
		});
		await server.close();
	});

	test("reads a semver version from package.json", () => {
		expect(SERVER_NAME).toBe("langmail-mcp");
		expect(readPackageVersion()).toMatch(SEMVER);
	});

	test("does not contact Stalwart to build the server or answer the handshake", async () => {
		const live = fakeLive(() => Promise.resolve(session("user@example.com")));
		const client = await connect(
			createServer(config, createRuntime(config, live))
		);
		expect(live.seen).toEqual([]);
		await client.close();
	});

	test("unsubscribe_from_list sends the one-click request only when the configuration allows it", async () => {
		const describeFor = async (allowUnsubscribePost: boolean) => {
			const cfg: Config = { ...config, allowUnsubscribePost };
			const live = fakeLive(() => Promise.resolve(session("user@example.com")));
			const client = await connect(createServer(cfg, createRuntime(cfg, live)));
			const listed = await client.request("tools/list");
			await client.close();
			return (listed.tools as { description: string; name: string }[]).find(
				(tool) => tool.name === "unsubscribe_from_list"
			)?.description;
		};
		expect(await describeFor(false)).toContain(
			"LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST on; it is off on this server"
		);
		const on = await describeFor(true);
		expect(on).toContain("sends the request itself. It never sends mail");
		expect(on).not.toContain("LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST");
	});

	test("hands a tool the credential and the principal from the JMAP session", async () => {
		await quietly(async () => {
			const live = fakeLive(() => Promise.resolve(session("user@example.com")));
			const runtime = createRuntime(config, live);
			const server = createServer(config, runtime);
			registerWhoami(server, runtime.getToken, runtime.getPrincipal);
			const client = await connect(server);

			const listed = await client.request("tools/list");
			expect(
				(listed.tools as { name: string }[]).map((tool) => tool.name)
			).toContain("whoami");

			const first = await client.request("tools/call", {
				arguments: {},
				name: "whoami",
			});
			expect(first.isError).toBeUndefined();
			expect(textOf(first)).toBe(`user@example.com ${CREDENTIAL}`);
			await client.request("tools/call", { arguments: {}, name: "whoami" });
			// Signed in once, with the credential as the Authorization value.
			expect(live.seen).toEqual([CREDENTIAL]);
			await client.close();
		});
	});

	test("a rejected credential fails the tool call with what to check, and the next call tries again", async () => {
		await quietly(async () => {
			let status = 401;
			const live = fakeLive(() =>
				status === 200
					? Promise.resolve(session("user@example.com"))
					: Promise.reject(
							new JmapError(status, `jmap session returned ${status}`)
						)
			);
			const runtime = createRuntime(config, live);
			const server = createServer(config, runtime);
			registerWhoami(server, runtime.getToken, runtime.getPrincipal);
			const client = await connect(server);

			const refused = await client.request("tools/call", {
				arguments: {},
				name: "whoami",
			});
			expect(refused.isError).toBe(true);
			expect(textOf(refused)).toContain("rejected the credential (HTTP 401)");
			expect(textOf(refused)).toContain("STALWART_PASSWORD");
			expect(textOf(refused)).toContain("https://mail.example.com");
			// The secret itself is never part of the answer.
			expect(textOf(refused)).not.toContain(CREDENTIAL);

			status = 200;
			const accepted = await client.request("tools/call", {
				arguments: {},
				name: "whoami",
			});
			expect(textOf(accepted)).toBe(`user@example.com ${CREDENTIAL}`);
			expect(live.seen).toHaveLength(2);
			await client.close();
		});
	});
});

describe("createRuntime", () => {
	test("reports an unreachable server and a non-JMAP answer in plain words", async () => {
		const unreachable = createRuntime(
			config,
			fakeLive(() => Promise.reject(new TypeError("fetch failed")))
		);
		await expect(unreachable.signIn()).rejects.toThrow(
			"Could not reach Stalwart at https://mail.example.com. Check STALWART_URL"
		);

		const notJmap = createRuntime(
			config,
			fakeLive(() =>
				Promise.reject(new JmapError(404, "jmap session returned 404"))
			)
		);
		await expect(notJmap.signIn()).rejects.toThrow(
			"did not answer the JMAP session request as expected (jmap session returned 404)"
		);
	});

	test("an anonymous session is not a sign-in", async () => {
		const runtime = createRuntime(
			config,
			fakeLive(() => Promise.resolve(session()))
		);
		await expect(runtime.signIn()).rejects.toThrow(
			"answered without naming an account"
		);
		expect(() => runtime.getPrincipal()).toThrow(
			"the principal was read before signing in"
		);
	});

	test("exposes the Stalwart URL and one session cache", () => {
		const live = fakeLive(() => Promise.resolve(session("user@example.com")));
		const runtime = createRuntime(config, live);
		expect(runtime.stalwartUrl).toBe("https://mail.example.com");
		expect(runtime.jmapLive).toBe(live);
	});
});
