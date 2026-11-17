import { createServer as createHttpServer, type Server } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Config } from "../config.ts";
import type { HttpListener } from "../http/listener.ts";
import type { JmapLive } from "../jmap/index.ts";
import { logger } from "../logger.ts";
import { createRuntime, type ServerRuntime } from "./handler.ts";
import { linkRoutes, startLinkListener } from "./links.ts";

const CREDENTIAL = "Basic dXNlckBleGFtcGxlLmNvbTpzZWNyZXQ=";
const PDF = "%PDF-1.4 fake";
const LOOPBACK_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d+$/u;

const config: Config = {
	allowRemoteImages: false,
	allowUnsubscribePost: false,
	credential: CREDENTIAL,
	stalwartUrl: "https://mail.example.com",
	transport: { kind: "stdio" },
};

const listeners: HttpListener[] = [];
const servers: Server[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(listeners.splice(0).map((listener) => listener.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise((resolve) => {
					server.close(resolve);
					server.closeAllConnections();
				})
		)
	);
});

const listenOn = (server: Server): Promise<number> =>
	new Promise((resolve) => {
		servers.push(server);
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as AddressInfo).port)
		);
	});

// A stand-in for the mail server's blob endpoints: it answers a download with
// a small file and an upload with a blob id, and records what it was sent.
const fakeMailServer = async (): Promise<{
	live: JmapLive;
	seen: {
		authorization?: string;
		body: string;
		method?: string;
		url?: string;
	}[];
}> => {
	const seen: {
		authorization?: string;
		body: string;
		method?: string;
		url?: string;
	}[] = [];
	const server = createHttpServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				authorization: req.headers.authorization,
				body: Buffer.concat(chunks).toString(),
				method: req.method,
				url: req.url,
			});
			if (req.method === "POST") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ blobId: "Gstored" }));
				return;
			}
			res.writeHead(200, { "content-type": "application/pdf" });
			res.end(PDF);
		});
	});
	const base = `http://127.0.0.1:${await listenOn(server)}`;
	const live: JmapLive = {
		getSession: () =>
			Promise.resolve({
				apiUrl: `${base}/jmap/`,
				downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
				primaryAccounts: { "urn:ietf:params:jmap:mail": "acct" },
				uploadUrl: `${base}/jmap/upload/{accountId}/`,
			}),
		resolveAccountId: () => Promise.resolve("acct"),
	};
	return { live, seen };
};

const start = async (
	runtime: ServerRuntime,
	port?: number
): Promise<HttpListener> => {
	const listener = await startLinkListener(runtime, port);
	listeners.push(listener);
	return listener;
};

const neverAsked: JmapLive = {
	getSession: () => Promise.reject(new Error("must not be asked")),
	resolveAccountId: () => Promise.reject(new Error("must not be asked")),
};

describe("linkRoutes", () => {
	test("has no image-proxy route unless remote images are turned on", () => {
		const off = createRuntime(config, neverAsked);
		expect(off.imageTokens).toBeUndefined();
		expect(linkRoutes(off).map((route) => route.path)).toEqual([
			"/attachments/",
		]);

		const on = createRuntime(
			{ ...config, allowRemoteImages: true },
			neverAsked
		);
		expect(on.imageTokens).toBeDefined();
		expect(linkRoutes(on).map((route) => route.path)).toEqual([
			"/attachments/",
			"/image-proxy/",
		]);
	});
});

describe("startLinkListener", () => {
	test("with remote images off, /image-proxy/ is a plain 404 and nothing is fetched", async () => {
		const request = vi.spyOn(https, "request");
		const links = await start(createRuntime(config, neverAsked));
		// A token shaped like a real one: there is no store it could be in.
		const token = Buffer.alloc(32, 7).toString("base64url");
		for (const path of [
			`/image-proxy/${token}`,
			"/image-proxy/",
			"/image-proxy",
		]) {
			const res = await fetch(`${links.origin}${path}`);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
		}
		expect(request).not.toHaveBeenCalled();
	});

	test("with remote images on, the route redeems only a clean GET of one token", async () => {
		const request = vi.spyOn(https, "request");
		const runtime = createRuntime(
			{ ...config, allowRemoteImages: true },
			neverAsked
		);
		const links = await start(runtime);
		const token = runtime.imageTokens?.mint("https://cdn.example.com/a.png");
		for (const [path, method] of [
			["/image-proxy/unknown-token", "GET"],
			[`/image-proxy/${token}/more`, "GET"],
			[`/image-proxy/${token}`, "POST"],
			["/image-proxy/", "GET"],
		] as const) {
			const res = await fetch(`${links.origin}${path}`, { method });
			expect(res.status).toBe(404);
		}
		// None of those reached the fetch: an unknown token and a wrong shape
		// are refused first.
		expect(request).not.toHaveBeenCalled();
	});

	test("binds a free loopback port and redeems the runtime's tickets in both directions", async () => {
		const { live, seen } = await fakeMailServer();
		const runtime = createRuntime(config, live);
		const links = await start(runtime);
		expect(links.host).toBe("127.0.0.1");
		expect(links.origin).toMatch(LOOPBACK_ORIGIN_RE);

		const ticket = runtime.tickets.mint({
			accountId: "acct",
			authorization: CREDENTIAL,
			blobId: "Gd41d8cd",
			name: "invoice.pdf",
			type: "application/pdf",
		});
		// No Authorization header: the ticket is the credential.
		const download = await fetch(`${links.origin}/attachments/${ticket}`);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("application/pdf");
		expect(download.headers.get("content-disposition")).toBe(
			"attachment; filename=\"invoice.pdf\"; filename*=UTF-8''invoice.pdf"
		);
		expect(await download.text()).toBe(PDF);

		const upload = runtime.uploadTickets.mint({
			accountId: "acct",
			authorization: CREDENTIAL,
			filename: "scan.pdf",
			type: "application/pdf",
		});
		const put = await fetch(
			`${links.origin}/attachments/uploads/${upload.token}`,
			{ body: "the file", method: "PUT" }
		);
		expect(put.status).toBe(200);
		expect(((await put.json()) as { blobId: string }).blobId).toBe("Gstored");

		// The mail server saw the runtime's credential, never the caller's.
		expect(seen.map((request) => request.authorization)).toEqual([
			CREDENTIAL,
			CREDENTIAL,
		]);
		expect(seen[0]?.url).toBe(
			"/jmap/download/acct/Gd41d8cd/invoice.pdf?accept=application%2Fpdf"
		);
		expect(seen[1]).toMatchObject({ body: "the file", method: "POST" });
	});

	test("serves nothing but the ticket routes: no /mcp, no health route", async () => {
		const links = await start(createRuntime(config, neverAsked));
		for (const path of [
			"/mcp",
			"/healthz",
			"/",
			"/attachments/",
			"/attachments",
		]) {
			const res = await fetch(`${links.origin}${path}`);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
		}
		const mcp = await fetch(`${links.origin}/mcp`, {
			body: "{}",
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(mcp.status).toBe(404);
		// An unknown ticket is the same plain 404.
		expect((await fetch(`${links.origin}/attachments/garbage`)).status).toBe(
			404
		);
	});

	test("refuses a request a web page made, even with a valid ticket", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const runtime = createRuntime(config, neverAsked);
		const links = await start(runtime);
		const ticket = runtime.tickets.mint({
			accountId: "acct",
			authorization: CREDENTIAL,
			blobId: "b1",
			name: "a.pdf",
			type: "application/pdf",
		});
		const res = await fetch(`${links.origin}/attachments/${ticket}`, {
			headers: { origin: "https://attacker.example.com" },
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toBe('{"error":"forbidden"}\n');
	});

	test("uses the port it is given", async () => {
		// Find a free port by binding one and letting go of it.
		const probe = await start(createRuntime(config, neverAsked));
		const { port } = probe;
		await probe.close();

		const links = await start(createRuntime(config, neverAsked), port);
		expect(links.origin).toBe(`http://127.0.0.1:${port}`);
	});

	test("a port that is taken does not stop it: it says so and binds a free one", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const first = await start(createRuntime(config, neverAsked));

		const second = await start(createRuntime(config, neverAsked), first.port);
		expect(second.port).not.toBe(first.port);
		expect(second.host).toBe("127.0.0.1");
		expect(warn).toHaveBeenCalledWith(
			{ port: first.port },
			"the port set in MCP_PORT cannot be used for file links; using a free port instead"
		);
		expect((await fetch(`${second.origin}/attachments/x`)).status).toBe(404);
	});
});
