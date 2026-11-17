// Starts the built server (`dist/index.js`) the way a user's agent does, and
// hands back an MCP client connected to it: over stdio, or over Streamable
// HTTP with the bearer token.
//
// The server under test is the build, not the source: `npm run test:e2e`
// builds first, and a suite run on its own fails here with what to do when
// `dist/` is missing or older than `src/`.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import type { TestAccount } from "./admin.ts";
import { ADMIN_URL } from "./env.ts";
import { pollUntil } from "./wait.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(ROOT, "src");
const ENTRY = join(ROOT, "dist", "index.js");

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const START_ATTEMPTS = 3;
const TOKEN_BYTES = 24;
const HTTP_OK = 200;
const TEST_FILE_RE = /\.test\.ts$/u;

const CLIENT_INFO = { name: "langmail-mcp-e2e", version: "0.0.0" };

const newestSourceChange = (dir: string): number => {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, newestSourceChange(path));
		} else if (entry.name.endsWith(".ts") && !TEST_FILE_RE.test(entry.name)) {
			newest = Math.max(newest, statSync(path).mtimeMs);
		}
	}
	return newest;
};

/** Fails with what to run when `dist/` is missing or older than `src/`. */
export const assertBuilt = (): void => {
	if (!existsSync(ENTRY)) {
		throw new Error(
			"dist/index.js does not exist: these suites start the built server. Run `npm run build` first (`npm run test:e2e` does)."
		);
	}
	if (statSync(ENTRY).mtimeMs < newestSourceChange(SRC_DIR)) {
		throw new Error(
			"dist/ is older than src/: these suites start the built server and would test stale code. Run `npm run build` first (`npm run test:e2e` does)."
		);
	}
};

export interface ServerOptions {
	/** Environment on top of the account's, e.g. `LOG_LEVEL` or an opt-in flag. */
	env?: Record<string, string>;
}

/** What the server reads to sign in to the live Stalwart as `account`, with its app password. */
export const accountEnv = (account: TestAccount): Record<string, string> => ({
	STALWART_PASSWORD: account.secret,
	STALWART_URL: ADMIN_URL,
	STALWART_USERNAME: account.address,
});

// The child gets a clean environment: what a process needs to run (PATH,
// HOME, …) plus the settings given here, and nothing this shell happens to
// have set (`MCP_TRANSPORT`, `STALWART_TOKEN`, a `.env` someone sourced).
const childEnv = (
	account: TestAccount,
	options: ServerOptions,
	extra: Record<string, string> = {}
): Record<string, string> => ({
	...getDefaultEnvironment(),
	...accountEnv(account),
	...extra,
	...options.env,
});

export interface StdioServer {
	/** A client that has completed the MCP handshake. */
	client: Client;
	/** Everything the server has written to stderr so far. */
	stderr: () => string;
	/** Closes the client, which ends the server process. */
	stop: () => Promise<void>;
}

/** Spawns `node dist/index.js` and connects a client to it over stdio. */
export const startStdioServer = async (
	account: TestAccount,
	options: ServerOptions = {}
): Promise<StdioServer> => {
	assertBuilt();
	const transport = new StdioClientTransport({
		args: [ENTRY],
		command: process.execPath,
		cwd: ROOT,
		env: childEnv(account, options),
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const client = new Client(CLIENT_INFO);
	try {
		await client.connect(transport);
	} catch (error) {
		await client.close().catch(() => undefined);
		throw new Error(
			`the stdio server did not complete the MCP handshake. Its stderr:\n${stderr}`,
			{ cause: error }
		);
	}
	return {
		client,
		stderr: () => stderr,
		stop: () => client.close(),
	};
};

export interface HttpServer {
	/** `http://127.0.0.1:<port>`, without a trailing slash. */
	baseUrl: string;
	/** A client connected with the right token. */
	client: Client;
	/**
	 * Connects a further client. Pass a token to present that one instead of
	 * the right one, or `null` to send no Authorization header. Rejects when
	 * the server refuses the handshake. Clients are closed by `stop`.
	 */
	connect: (token?: string | null) => Promise<Client>;
	/** `<baseUrl>/mcp`. */
	mcpUrl: string;
	/** The server's process id. */
	pid: number;
	/** Everything the server has written to stderr so far. */
	stderr: () => string;
	/**
	 * Closes the clients and stops the server with SIGTERM. Resolves with the
	 * exit code: 0 for a clean shutdown.
	 */
	stop: () => Promise<number | null>;
	/** The value of `MCP_AUTH_TOKEN` the server was started with. */
	token: string;
}

// The server takes a port number, not "any free port", so one is found by
// binding port 0 and letting go of it. Another process can take it in
// between, which is why starting is retried.
const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, HOST, () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});

const exited = (child: ChildProcess): boolean =>
	child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child: ChildProcess): Promise<number | null> =>
	new Promise((resolve) => {
		if (exited(child)) {
			resolve(child.exitCode);
			return;
		}
		const kill = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
		child.once("exit", (code) => {
			clearTimeout(kill);
			resolve(code);
		});
	});

export interface RawStdioServer {
	/**
	 * Closes the server's stdin and sends no signal, as a client that goes
	 * away does. Resolves with the exit code once the server has ended by
	 * itself: 0 for a clean end, `null` when it had to be killed.
	 */
	end: () => Promise<number | null>;
	/** The server's process id. */
	pid: number;
	/**
	 * Writes one JSON-RPC request to the server's stdin and resolves with the
	 * message on its stdout that answers it.
	 */
	request: (
		method: string,
		params?: Record<string, unknown>
	) => Promise<Record<string, unknown>>;
	/** Everything the server has written to stderr so far. */
	stderr: () => string;
	/** Every complete line the server has written to stdout so far. */
	stdoutLines: () => string[];
	/** Closes the server's stdin and stops it. */
	stop: () => Promise<number | null>;
}

const parsedLine = (line: string): Record<string, unknown> | undefined => {
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		// Not JSON: for the suite to judge, through `stdoutLines`.
		return undefined;
	}
};

/**
 * Spawns `node dist/index.js` and speaks MCP to it over its pipes by hand,
 * handshake included, keeping every line of its stdout. The SDK's client
 * skips stdout lines that are not JSON, so a suite that asks what the server
 * writes there has to read the pipe itself.
 */
export const startRawStdioServer = async (
	account: TestAccount,
	options: ServerOptions = {}
): Promise<RawStdioServer> => {
	assertBuilt();
	const child = spawn(process.execPath, [ENTRY], {
		cwd: ROOT,
		env: childEnv(account, options),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	// The text after the last newline is a line still being written.
	const stdoutLines = (): string[] => stdout.split("\n").slice(0, -1);
	const send = (message: Record<string, unknown>): void => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};

	let lastId = 0;
	const request = async (
		method: string,
		params: Record<string, unknown> = {}
	): Promise<Record<string, unknown>> => {
		lastId += 1;
		const id = lastId;
		send({ id, method, params });
		const answer = await pollUntil(
			() =>
				Promise.resolve(
					exited(child)
						? { exited: true }
						: stdoutLines()
								.map(parsedLine)
								.find((message) => message?.id === id)
				),
			(found) => found !== undefined,
			{
				intervalMs: 20,
				timeoutMs: START_TIMEOUT_MS,
				waitingFor: `the stdio server's answer to ${method}. Its stderr:\n${stderr}`,
			}
		);
		if (exited(child)) {
			throw new Error(
				`the stdio server exited with code ${child.exitCode} before answering ${method}. Its stderr:\n${stderr}`
			);
		}
		return answer as Record<string, unknown>;
	};

	const stop = (): Promise<number | null> => {
		child.stdin.end();
		child.kill("SIGTERM");
		return waitForExit(child);
	};

	const end = (): Promise<number | null> => {
		child.stdin.end();
		return waitForExit(child);
	};

	try {
		await request("initialize", {
			capabilities: {},
			clientInfo: CLIENT_INFO,
			protocolVersion: "2025-06-18",
		});
		send({ method: "notifications/initialized" });
	} catch (error) {
		await stop();
		throw error;
	}
	return {
		end,
		pid: child.pid as number,
		request,
		stderr: () => stderr,
		stdoutLines,
		stop,
	};
};

interface SpawnedHttp {
	baseUrl: string;
	child: ChildProcess;
	stderr: () => string;
}

const spawnHttp = async (
	account: TestAccount,
	options: ServerOptions,
	token: string
): Promise<SpawnedHttp> => {
	const port = await freePort();
	const baseUrl = `http://${HOST}:${port}`;
	const child = spawn(process.execPath, [ENTRY, "--http"], {
		cwd: ROOT,
		env: childEnv(account, options, {
			MCP_AUTH_TOKEN: token,
			MCP_HOST: HOST,
			MCP_PORT: String(port),
		}),
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const ready = async (): Promise<boolean> => {
		if (exited(child)) {
			return true;
		}
		try {
			return (await fetch(`${baseUrl}/healthz`)).status === HTTP_OK;
		} catch {
			// Not listening yet.
			return false;
		}
	};
	try {
		await pollUntil(ready, (isReady) => isReady, {
			timeoutMs: START_TIMEOUT_MS,
			waitingFor: `the HTTP server on ${baseUrl}`,
		});
	} catch (error) {
		child.kill("SIGKILL");
		throw new Error(`${String(error)}. Its stderr:\n${stderr}`, {
			cause: error,
		});
	}
	if (exited(child)) {
		throw new Error(
			`the HTTP server exited with code ${child.exitCode} before it listened on ${baseUrl}. Its stderr:\n${stderr}`
		);
	}
	return { baseUrl, child, stderr: () => stderr };
};

const spawnHttpWithRetry = async (
	account: TestAccount,
	options: ServerOptions,
	token: string
): Promise<SpawnedHttp> => {
	let failure: unknown;
	for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
		try {
			return await spawnHttp(account, options, token);
		} catch (error) {
			failure = error;
			// Only a lost race for the port is worth another try.
			if (!String(error).includes("already in use")) {
				break;
			}
		}
	}
	throw failure;
};

/**
 * Spawns `node dist/index.js --http` on a free loopback port with a fresh
 * token, waits until it listens, and connects a client with that token.
 */
export const startHttpServer = async (
	account: TestAccount,
	options: ServerOptions = {}
): Promise<HttpServer> => {
	assertBuilt();
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	const { baseUrl, child, stderr } = await spawnHttpWithRetry(
		account,
		options,
		token
	);
	const mcpUrl = `${baseUrl}/mcp`;
	const clients: Client[] = [];

	const connect = async (presented: string | null = token): Promise<Client> => {
		const client = new Client(CLIENT_INFO);
		clients.push(client);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(mcpUrl), {
				requestInit: {
					headers:
						presented === null ? {} : { authorization: `Bearer ${presented}` },
				},
			})
		);
		return client;
	};

	const stop = async (): Promise<number | null> => {
		await Promise.all(
			clients.splice(0).map((opened) => opened.close().catch(() => undefined))
		);
		child.kill("SIGTERM");
		return waitForExit(child);
	};

	let client: Client;
	try {
		client = await connect();
	} catch (error) {
		await stop();
		throw new Error(
			`the HTTP server on ${baseUrl} did not complete the MCP handshake. Its stderr:\n${stderr()}`,
			{ cause: error }
		);
	}
	return {
		baseUrl,
		client,
		connect,
		mcpUrl,
		pid: child.pid as number,
		stderr,
		stop,
		token,
	};
};

const PROC_TCP_TABLES = ["net/tcp", "net/tcp6"];
const TCP_STATE_LISTEN = "0A";
const SOCKET_LINK_RE = /^socket:\[(\d+)\]$/u;
const WHITESPACE_RE = /\s+/u;

/** Whether `listeningTcpPorts` can answer here: it reads Linux's `/proc`. */
export const canListListeningTcpPorts = existsSync("/proc/self/net/tcp");

export interface ListeningTcpSocket {
	/**
	 * The address the socket is bound to: dotted IPv4 (`127.0.0.1`, or
	 * `0.0.0.0` for every interface), or for an IPv6 socket its 32 hex digits
	 * in network order (`::1` ends in `…0001`, `::` is all zeros).
	 */
	address: string;
	port: number;
}

const HEX_BYTE_RE = /../gu;
const IPV4_HEX_LENGTH = 8;

// `/proc/net/tcp` prints an address as 32-bit words in the machine's byte
// order: on the little-endian machines these suites run on, each word's
// bytes are reversed.
const wordBytes = (hex: string): string[] =>
	(hex.match(HEX_BYTE_RE) ?? []).reverse();

const decodeAddress = (hex: string): string => {
	if (hex.length === IPV4_HEX_LENGTH) {
		return wordBytes(hex)
			.map((byte) => Number.parseInt(byte, 16))
			.join(".");
	}
	let address = "";
	for (let i = 0; i < hex.length; i += IPV4_HEX_LENGTH) {
		address += wordBytes(hex.slice(i, i + IPV4_HEX_LENGTH)).join("");
	}
	return address.toLowerCase();
};

/**
 * The TCP sockets a process is listening on, with the address each is bound
 * to, read from `/proc`: the sockets among its open files that the kernel's
 * TCP tables list in state LISTEN. Linux only; see `canListListeningTcpPorts`.
 */
export const listeningTcpSockets = (pid: number): ListeningTcpSocket[] => {
	const sockets = new Set<string>();
	for (const fd of readdirSync(`/proc/${pid}/fd`)) {
		try {
			const inode = SOCKET_LINK_RE.exec(
				readlinkSync(`/proc/${pid}/fd/${fd}`)
			)?.[1];
			if (inode) {
				sockets.add(inode);
			}
		} catch {
			// Closed between listing and reading.
		}
	}
	const listening: ListeningTcpSocket[] = [];
	for (const table of PROC_TCP_TABLES) {
		const path = `/proc/${pid}/${table}`;
		if (!existsSync(path)) {
			continue;
		}
		// Columns: sl, local address, remote address, state, queues, timer (two
		// columns), retransmits, uid, timeout, inode.
		for (const line of readFileSync(path, "utf8").split("\n").slice(1)) {
			const columns = line.trim().split(WHITESPACE_RE);
			const [, local, , state] = columns;
			const inode = columns[9];
			if (state === TCP_STATE_LISTEN && local && inode && sockets.has(inode)) {
				const colon = local.lastIndexOf(":");
				listening.push({
					address: decodeAddress(local.slice(0, colon)),
					port: Number.parseInt(local.slice(colon + 1), 16),
				});
			}
		}
	}
	return listening.sort((a, b) => a.port - b.port);
};

/**
 * The TCP ports a process is listening on. Linux only; see
 * `canListListeningTcpPorts`.
 */
export const listeningTcpPorts = (pid: number): number[] =>
	listeningTcpSockets(pid).map((socket) => socket.port);
