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
import { connect, textOf } from "./test-client.ts";

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

	test("lists preview_email third, bound to the viewer template, whatever the remote-image setting", async () => {
		for (const allowRemoteImages of [false, true]) {
			const cfg: Config = { ...config, allowRemoteImages };
			const live = fakeLive(() => Promise.resolve(session("user@example.com")));
			const client = await connect(createServer(cfg, createRuntime(cfg, live)));
			const { tools } = (await client.request("tools/list")) as unknown as {
				tools: {
					_meta?: Record<string, unknown>;
					description: string;
					name: string;
					outputSchema?: unknown;
				}[];
			};
			await client.close();
			expect(tools.slice(0, 4).map((tool) => tool.name)).toEqual([
				"search_emails",
				"get_email",
				"preview_email",
				"get_thread",
			]);
			const preview = tools[2];
			expect(preview?._meta).toEqual({
				ui: { resourceUri: "ui://langmail/email-viewer" },
				"ui/resourceUri": "ui://langmail/email-viewer",
			});
			expect(preview?.outputSchema).toBeDefined();
			// The description is the hosted server's, with or without the flag.
			expect(preview?.description).not.toContain("LANGMAIL_MCP");
		}
	});

	test("over stdio, listing the viewer template names no origin and starts no listener", async () => {
		const started: (number | undefined)[] = [];
		const live = fakeLive(() => Promise.resolve(session("user@example.com")));
		const runtime = createRuntime(config, live, (_, port) => {
			started.push(port);
			return Promise.resolve("http://127.0.0.1:4711");
		});
		const client = await connect(createServer(config, runtime));
		await client.request("tools/list");
		const listed = await client.request("resources/list");
		expect(listed.resources).toEqual([
			{
				_meta: { ui: { prefersBorder: true } },
				description:
					"Inline full-fidelity rendering of one email, fed by the preview_email tool.",
				mimeType: "text/html;profile=mcp-app",
				name: "email-viewer",
				uri: "ui://langmail/email-viewer",
			},
		]);
		expect(started).toEqual([]);
		await client.close();
	});

	test("over HTTP, the listed viewer template may load from the public URL's origin only", async () => {
		const cfg: Config = {
			...config,
			transport: {
				authToken: "a-long-random-secret",
				host: "127.0.0.1",
				kind: "http",
				port: 8080,
				publicUrl: "https://mcp.example.com/base",
			},
		};
		const live = fakeLive(() => Promise.resolve(session("user@example.com")));
		const client = await connect(createServer(cfg, createRuntime(cfg, live)));
		const listed = (await client.request("resources/list")) as unknown as {
			resources: { _meta?: unknown }[];
		};
		await client.close();
		expect(listed.resources[0]?._meta).toEqual({
			ui: {
				csp: { resourceDomains: ["https://mcp.example.com"] },
				prefersBorder: true,
			},
		});
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

	test("mints file links under the HTTP transport's public URL, and holds one ticket store of each kind", async () => {
		const http: Config = {
			...config,
			transport: {
				authToken: "a-long-random-secret",
				host: "127.0.0.1",
				kind: "http",
				port: 8080,
				publicUrl: "https://mcp.example.com",
			},
		};
		const runtime = createRuntime(http, undefined, () =>
			Promise.reject(new Error("the HTTP transport starts no link listener"))
		);
		expect(await runtime.publicUrl()).toBe("https://mcp.example.com");
		const ticket = runtime.tickets.mint({
			accountId: "acct-1",
			authorization: CREDENTIAL,
			blobId: "b1",
			name: "a.pdf",
			type: "application/pdf",
		});
		expect(runtime.tickets.lookup(ticket)?.blobId).toBe("b1");
		const upload = runtime.uploadTickets.mint({
			accountId: "acct-1",
			authorization: CREDENTIAL,
			filename: "a.pdf",
			type: "application/pdf",
		});
		expect(runtime.uploadTickets.take(upload.token)?.filename).toBe("a.pdf");
		// A second runtime shares nothing with the first.
		expect(createRuntime(http).tickets.lookup(ticket)).toBeNull();
	});

	test("over stdio, nothing serves links until a tool mints one; then one listener serves them all", async () => {
		const started: (number | undefined)[] = [];
		const live = fakeLive(() => Promise.resolve(session("user@example.com")));
		const cfg: Config = {
			...config,
			transport: { kind: "stdio", linkPort: 4711 },
		};
		const runtime = createRuntime(cfg, live, (given, port) => {
			expect(given).toBe(runtime);
			started.push(port);
			return Promise.resolve("http://127.0.0.1:4711");
		});
		const client = await connect(createServer(cfg, runtime));
		// Building the server, the handshake and listing the tools start nothing.
		await client.request("tools/list");
		expect(started).toEqual([]);

		const upload = () =>
			client.request("tools/call", {
				arguments: { files: [{ filename: "scan.pdf" }] },
				name: "upload_attachments",
			});
		// Two tools minting at once share the one start.
		const [first, second] = await Promise.all([upload(), upload()]);
		expect(textOf(first)).toContain(
			"'http://127.0.0.1:4711/attachments/uploads/"
		);
		expect(textOf(second)).toContain(
			"'http://127.0.0.1:4711/attachments/uploads/"
		);
		await upload();
		expect(started).toEqual([4711]);
		await client.close();
	});

	test("over stdio, a link listener that cannot start fails that tool call, and the next one tries again", async () => {
		await quietly(async () => {
			let attempts = 0;
			const live = fakeLive(() => Promise.resolve(session("user@example.com")));
			const runtime = createRuntime(config, live, () => {
				attempts += 1;
				return attempts === 1
					? Promise.reject(new Error("cannot listen on 127.0.0.1:0: denied"))
					: Promise.resolve("http://127.0.0.1:5000");
			});
			const client = await connect(createServer(config, runtime));
			const upload = () =>
				client.request("tools/call", {
					arguments: { files: [{ filename: "scan.pdf" }] },
					name: "upload_attachments",
				});
			const failed = await upload();
			expect(failed.isError).toBe(true);
			expect(textOf(failed)).toContain("cannot listen on 127.0.0.1:0");
			// No ticket is left behind without a link to it.
			expect(textOf(await upload())).toContain(
				"'http://127.0.0.1:5000/attachments/uploads/"
			);
			expect(attempts).toBe(2);
			await client.close();
		});
	});

	test("exposes the Stalwart URL and one session cache", () => {
		const live = fakeLive(() => Promise.resolve(session("user@example.com")));
		const runtime = createRuntime(config, live);
		expect(runtime.stalwartUrl).toBe("https://mail.example.com");
		expect(runtime.jmapLive).toBe(live);
	});
});
