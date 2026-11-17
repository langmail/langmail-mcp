// Serves a fetch-style handler (`Request` in, `Response` out) over `node:http`.
//
// The routes are written against the web-standard `Request` and `Response`,
// which is also what the MCP SDK's HTTP transport speaks. This file is the
// only place that touches Node's own request and response objects.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { logger } from "../logger.ts";
import { describeError } from "../observability/errors.ts";
import { urlHostname } from "./hosts.ts";
import type { FetchHandler } from "./routes.ts";

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
const DEFAULT_CLOSE_GRACE_MS = 5000;
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export interface HttpListenerOptions {
	// How long `close` lets requests in flight finish before it cuts them off.
	closeGraceMs?: number;
	fetch: FetchHandler;
	host: string;
	// 0 lets the system pick a free port; read it back from `port`.
	port: number;
}

export interface HttpListener {
	// Stops accepting connections, lets requests in flight finish (up to the
	// grace period), then resolves.
	close: () => Promise<void>;
	host: string;
	// `http://host:port`, the address the listener is bound to.
	origin: string;
	// The port actually bound.
	port: number;
}

const toWebRequest = (req: IncomingMessage, signal: AbortSignal): Request => {
	// The URL's host is only a label here: routing reads the path, and the
	// guard reads the Host header itself.
	const url = new URL(req.url ?? "/", "http://localhost");
	const headers = new Headers();
	for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
		headers.append(req.rawHeaders[i] ?? "", req.rawHeaders[i + 1] ?? "");
	}
	const method = req.method ?? "GET";
	if (BODYLESS_METHODS.has(method)) {
		return new Request(url, { headers, method, signal });
	}
	return new Request(url, {
		body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
		// Node requires this to send a body that is still arriving.
		duplex: "half",
		headers,
		method,
		signal,
	} as RequestInit);
};

const writeResponse = async (
	response: Response,
	res: ServerResponse
): Promise<void> => {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of response.headers) {
		if (name !== "set-cookie") {
			headers[name] = value;
		}
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) {
		headers["set-cookie"] = cookies;
	}
	res.writeHead(response.status, headers);
	if (response.body === null) {
		res.end();
		return;
	}
	// A streamed answer (server-sent events) goes out chunk by chunk; when the
	// caller hangs up, the pipeline cancels the body so its source stops.
	await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
};

const serve = async (
	fetchHandler: FetchHandler,
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> => {
	const hungUp = new AbortController();
	res.once("close", () => {
		if (!res.writableFinished) {
			hungUp.abort();
		}
	});
	let request: Request;
	try {
		request = toWebRequest(req, hungUp.signal);
	} catch {
		// A request line or header Node let through but a Request cannot hold.
		res.writeHead(HTTP_BAD_REQUEST).end();
		return;
	}
	try {
		await writeResponse(await fetchHandler(request), res);
	} catch (error) {
		if (hungUp.signal.aborted) {
			return;
		}
		logger.error(describeError(error), "http unhandled request error");
		if (res.headersSent) {
			res.destroy();
		} else {
			res.writeHead(HTTP_INTERNAL_ERROR).end();
		}
	}
};

const listen = (server: Server, host: string, port: number): Promise<void> =>
	new Promise((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			reject(
				new Error(
					error.code === "EADDRINUSE"
						? `cannot listen on ${host}:${port}: the port is already in use. Set MCP_PORT to a free port.`
						: `cannot listen on ${host}:${port}: ${error.message}`,
					{ cause: error }
				)
			);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.off("error", onError);
			resolve();
		});
	});

// The connections of a server, and how many requests each is answering.
// `server.closeIdleConnections()` leaves a connection alone that has not sent
// a request yet, and such a connection would hold a shutdown open; this keeps
// count so that `close` can end every connection that is not mid-request.
const trackConnections = (
	server: Server
): { closeIdle: () => void; stopKeepingAlive: () => void } => {
	const inFlight = new Map<Socket, number>();
	let keepAlive = true;
	server.on("connection", (socket) => {
		inFlight.set(socket, 0);
		socket.once("close", () => inFlight.delete(socket));
	});
	server.on("request", (req, res) => {
		const { socket } = req;
		inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1);
		res.once("close", () => {
			const left = (inFlight.get(socket) ?? 1) - 1;
			if (inFlight.has(socket)) {
				inFlight.set(socket, left);
			}
			if (!keepAlive && left === 0) {
				// After the answer's last bytes are flushed.
				setImmediate(() => socket.destroy());
			}
		});
	});
	return {
		closeIdle: () => {
			for (const [socket, requests] of inFlight) {
				if (requests === 0) {
					socket.destroy();
				}
			}
		},
		stopKeepingAlive: () => {
			keepAlive = false;
		},
	};
};

/** Binds `host:port` and serves `fetch` on it. Rejects when the address cannot be bound. */
export const startHttpListener = async (
	options: HttpListenerOptions
): Promise<HttpListener> => {
	const server = createServer((req, res) => {
		serve(options.fetch, req, res).catch(() => res.destroy());
	});
	const connections = trackConnections(server);
	await listen(server, options.host, options.port);
	const { port } = server.address() as AddressInfo;
	const graceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

	const close = (): Promise<void> =>
		new Promise((resolve) => {
			const cutOff = setTimeout(() => server.closeAllConnections(), graceMs);
			server.close(() => {
				clearTimeout(cutOff);
				resolve();
			});
			connections.stopKeepingAlive();
			connections.closeIdle();
		});

	let closing: Promise<void> | undefined;
	return {
		close: () => {
			closing ??= close();
			return closing;
		},
		host: options.host,
		origin: `http://${urlHostname(options.host)}:${port}`,
		port,
	};
};
