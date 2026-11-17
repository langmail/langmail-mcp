import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { logger } from "../logger.ts";
import { type HttpListener, startHttpListener } from "./listener.ts";
import type { FetchHandler } from "./routes.ts";

const open: HttpListener[] = [];

const start = async (
	fetchHandler: FetchHandler,
	closeGraceMs?: number
): Promise<HttpListener> => {
	const listener = await startHttpListener({
		closeGraceMs,
		fetch: fetchHandler,
		host: "127.0.0.1",
		port: 0,
	});
	open.push(listener);
	return listener;
};

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(open.splice(0).map((listener) => listener.close()));
});

describe("startHttpListener", () => {
	test("binds a free port and reports where it listens", async () => {
		const listener = await start(() => Promise.resolve(new Response("hi")));
		expect(listener.port).toBeGreaterThan(0);
		expect(listener.host).toBe("127.0.0.1");
		expect(listener.origin).toBe(`http://127.0.0.1:${listener.port}`);
	});

	test("hands the handler the method, path, query, headers and body, and sends its answer back", async () => {
		const seen: Record<string, unknown> = {};
		const listener = await start(async (req) => {
			const url = new URL(req.url);
			seen.method = req.method;
			seen.path = url.pathname + url.search;
			seen.authorization = req.headers.get("authorization");
			seen.host = req.headers.get("host");
			seen.body = await req.text();
			return new Response('{"ok":true}', {
				headers: { "content-type": "application/json", "x-extra": "yes" },
				status: 201,
			});
		});
		const res = await fetch(`${listener.origin}/some/path?q=1`, {
			body: "the body",
			headers: { authorization: "Bearer abc" },
			method: "POST",
		});
		expect(res.status).toBe(201);
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(res.headers.get("x-extra")).toBe("yes");
		expect(await res.json()).toEqual({ ok: true });
		expect(seen).toEqual({
			authorization: "Bearer abc",
			body: "the body",
			host: `127.0.0.1:${listener.port}`,
			method: "POST",
			path: "/some/path?q=1",
		});
	});

	test("a GET has no body, and an answer without a body ends cleanly", async () => {
		const listener = await start((req) =>
			Promise.resolve(
				new Response(null, { status: req.body === null ? 204 : 500 })
			)
		);
		const res = await fetch(`${listener.origin}/`);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
	});

	test("a request the handler answers without reading its body still gets the answer", async () => {
		const listener = await start(() =>
			Promise.resolve(new Response("no", { status: 401 }))
		);
		const res = await fetch(`${listener.origin}/mcp`, {
			body: "x".repeat(200_000),
			method: "POST",
		});
		expect(res.status).toBe(401);
		expect(await res.text()).toBe("no");
	});

	test("a streamed answer arrives chunk by chunk, before the stream ends", async () => {
		const encoder = new TextEncoder();
		let finish: () => void = () => undefined;
		const listener = await start(() =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start: (controller) => {
							controller.enqueue(encoder.encode("event: message\n\n"));
							finish = () => {
								controller.enqueue(encoder.encode("event: done\n\n"));
								controller.close();
							};
						},
					}),
					{ headers: { "content-type": "text/event-stream" } }
				)
			)
		);
		const res = await fetch(`${listener.origin}/stream`);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const first = await reader.read();
		expect(decoder.decode(first.value)).toBe("event: message\n\n");
		finish();
		const second = await reader.read();
		expect(decoder.decode(second.value)).toBe("event: done\n\n");
		expect((await reader.read()).done).toBe(true);
	});

	test("a caller that hangs up aborts the request's signal and cancels a streamed answer", async () => {
		let aborted: (value: boolean) => void = () => undefined;
		const sawAbort = new Promise<boolean>((resolve) => {
			aborted = resolve;
		});
		let cancelled: (value: boolean) => void = () => undefined;
		const sawCancel = new Promise<boolean>((resolve) => {
			cancelled = resolve;
		});
		const listener = await start((req) => {
			req.signal.addEventListener("abort", () => aborted(true));
			return Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						cancel: () => cancelled(true),
						start: (controller) => {
							controller.enqueue(new TextEncoder().encode("first\n"));
						},
					})
				)
			);
		});
		const hangUp = new AbortController();
		const res = await fetch(`${listener.origin}/stream`, {
			signal: hangUp.signal,
		});
		await (res.body as ReadableStream<Uint8Array>).getReader().read();
		hangUp.abort();
		expect(await sawAbort).toBe(true);
		expect(await sawCancel).toBe(true);
	});

	test("a handler that rejects is answered with a bare 500 and logged", async () => {
		const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
		const listener = await start(() =>
			Promise.reject(new Error("handler fell over"))
		);
		const res = await fetch(`${listener.origin}/`);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("");
		expect(error.mock.calls[0]?.[1]).toBe("http unhandled request error");
	});

	test("Node refuses a request with no Host header before the handler sees it", async () => {
		const listener = await start((req) =>
			Promise.resolve(new Response(String(req.headers.get("host"))))
		);
		const body = await new Promise<string>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					path: "/",
					port: listener.port,
					setHost: false,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: Buffer) => {
						data += chunk.toString();
					});
					res.on("end", () => resolve(`${res.statusCode} ${data}`));
				}
			);
			req.on("error", reject);
			req.end();
		});
		// Node itself refuses an HTTP/1.1 request without Host.
		expect(body.startsWith("400")).toBe(true);
	});

	test("a port that is taken is reported with the setting to change", async () => {
		const taken = createServer();
		await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
		const { port } = taken.address() as { port: number };
		try {
			await expect(
				startHttpListener({
					fetch: () => Promise.resolve(new Response("x")),
					host: "127.0.0.1",
					port,
				})
			).rejects.toThrow(
				`cannot listen on 127.0.0.1:${port}: the port is already in use. Set MCP_PORT to a free port.`
			);
		} finally {
			await new Promise((resolve) => taken.close(resolve));
		}
	});
});

describe("close", () => {
	test("stops accepting connections and resolves; a second call is the same close", async () => {
		const listener = await start(() => Promise.resolve(new Response("hi")));
		// Leaves a keep-alive connection idle, which must not hold close open.
		await (await fetch(`${listener.origin}/`)).text();
		await Promise.all([listener.close(), listener.close()]);
		await expect(fetch(`${listener.origin}/`)).rejects.toThrow();
	});

	test("lets a request in flight finish", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => undefined;
		const inFlight = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const listener = await start(async () => {
			entered();
			await held;
			return new Response("finished");
		});
		const pending = fetch(`${listener.origin}/slow`);
		await inFlight;
		const closed = listener.close();
		release();
		expect(await (await pending).text()).toBe("finished");
		await closed;
	});

	test("cuts off a request that outlives the grace period", async () => {
		let entered: () => void = () => undefined;
		const inFlight = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const listener = await start(() => {
			entered();
			// Never answers.
			return new Promise<Response>(() => undefined);
		}, 50);
		const pending = fetch(`${listener.origin}/stuck`);
		await inFlight;
		await listener.close();
		await expect(pending).rejects.toThrow();
	});
});
