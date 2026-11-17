// Image proxy for the email-viewer: remote images referenced by an email's
// HTML are fetched by this server and streamed to the iframe, so the
// client never contacts the sender's (tracking) domains.
//
// This is traffic to hosts the sender chose, so it exists only when the user
// turns it on (LANGMAIL_MCP_ALLOW_REMOTE_IMAGES). Without the flag there is no
// store and no route, and preview_email drops remote images.
//
// Same capability-URL model as /attachments/<ticket>: preview_email mints an
// unguessable token per remote URL; GET /image-proxy/<token> redeems it.
// In-memory state is fine — one process, and a restart only breaks image
// URLs inside an already-rendered preview until the tool is re-called.
//
// The upstream URL is sender-controlled, so this is an SSRF surface:
// `isProxyableImageUrl` gates what gets minted (https, default port, public
// hostname shape, no credentials); at fetch time the hostname is resolved,
// every address must be public, and the connection is pinned to the checked
// address (resolve-and-pin), so a DNS-rebinding domain cannot swap in an
// internal one between check and connect. Redirects are refused rather than
// followed, and the response must be a raster image type within a byte cap
// enforced on the actual stream, not the declared length.

import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { Readable } from "node:stream";

import type { Route } from "../http/routes.ts";
import { logger } from "../logger.ts";

// A day, not minutes: these URLs are embedded in a rendered preview the user
// re-opens from conversation scrollback — a short TTL turns every image into
// a broken icon an hour later. The store is in-memory, so a restart still
// invalidates everything; that residual gap needs signed stateless URLs.
const IMAGE_PROXY_TTL_HOURS = 24;
const TTL_MS = IMAGE_PROXY_TTL_HOURS * 60 * 60 * 1000;

// Big enough for any real inline/hero image; a 4K photo attachment is not
// what an email body embeds.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 10_000;

// Hostname shapes that smell like an internal target rather than a public
// image host. A cheap mint-time filter; the resolved address is checked again
// at fetch time (`isPublicAddress`), which is the actual SSRF defense.
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const INTERNAL_SUFFIXES = [".internal", ".local", ".localdomain"];

export const isProxyableImageUrl = (raw: string): boolean => {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (
		url.protocol !== "https:" ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== ""
	) {
		return false;
	}
	const host = url.hostname.toLowerCase();
	if (
		host === "localhost" ||
		IP_LITERAL_RE.test(host) ||
		host.startsWith("[")
	) {
		return false;
	}
	if (!host.includes(".") || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
		return false;
	}
	return true;
};

// Non-public ranges a resolved upstream address must not fall into. An
// IPv4-mapped IPv6 address (::ffff:10.0.0.1) is matched against the IPv4
// rules by BlockList itself.
const NON_PUBLIC_RANGES: ReadonlyArray<
	readonly [string, number, "ipv4" | "ipv6"]
> = [
	["0.0.0.0", 8, "ipv4"], // "this network"
	["10.0.0.0", 8, "ipv4"], // RFC 1918
	["100.64.0.0", 10, "ipv4"], // CGNAT, also the tailnet range
	["127.0.0.0", 8, "ipv4"], // loopback
	["169.254.0.0", 16, "ipv4"], // link-local, cloud metadata
	["172.16.0.0", 12, "ipv4"], // RFC 1918
	["192.0.0.0", 24, "ipv4"], // IETF protocol assignments
	["192.168.0.0", 16, "ipv4"], // RFC 1918
	["198.18.0.0", 15, "ipv4"], // benchmarking
	["224.0.0.0", 4, "ipv4"], // multicast
	["240.0.0.0", 4, "ipv4"], // reserved, broadcast
	["::", 96, "ipv6"], // unspecified, loopback, IPv4-compatible
	["::ffff:0:0:0", 96, "ipv6"], // SIIT, embeds an IPv4 address
	["64:ff9b::", 96, "ipv6"], // NAT64, embeds an IPv4 address
	["64:ff9b:1::", 48, "ipv6"], // local-use NAT64
	["2002::", 16, "ipv6"], // 6to4, embeds an IPv4 address
	["fc00::", 7, "ipv6"], // unique local
	["fec0::", 10, "ipv6"], // deprecated site-local
	["fe80::", 10, "ipv6"], // link-local
	["ff00::", 8, "ipv6"], // multicast
];

const nonPublic = new BlockList();
for (const [network, prefix, family] of NON_PUBLIC_RANGES) {
	nonPublic.addSubnet(network, prefix, family);
}

// Fails closed: BlockList.check reports an unparseable string as unblocked,
// so anything that is not an IP literal is refused here.
export const isPublicAddress = (address: string): boolean => {
	if (isIPv6(address)) {
		return !nonPublic.check(address, "ipv6");
	}
	return isIPv4(address) && !nonPublic.check(address, "ipv4");
};

// All addresses the hostname resolves to; injectable so tests need no DNS.
export type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveHost: ResolveHost = async (hostname) =>
	(await lookup(hostname, { all: true })).map((entry) => entry.address);

export interface ImageProxyStore {
	// The upstream URL, or null when unknown/expired (indistinguishable).
	lookup: (token: string) => string | null;
	// Minted token (base64url, 256-bit). The same URL re-mints to the same
	// token while unexpired, so an email with a repeated logo yields one entry.
	mint: (url: string) => string;
}

const mintToken = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
};

export const createImageProxyStore = (
	now: () => number = Date.now
): ImageProxyStore => {
	const byToken = new Map<string, { expiresAt: number; url: string }>();
	const byUrl = new Map<string, string>();

	// Lazy sweep on mint/lookup keeps both maps bounded without a timer.
	const sweep = (): void => {
		const t = now();
		for (const [token, entry] of byToken) {
			if (entry.expiresAt <= t) {
				byToken.delete(token);
				byUrl.delete(entry.url);
			}
		}
	};

	return {
		lookup: (token) => {
			sweep();
			return byToken.get(token)?.url ?? null;
		},
		mint: (url) => {
			sweep();
			const existing = byUrl.get(url);
			if (existing) {
				// Restart the window: the preview minted just now must not ship
				// image URLs that inherit a nearly-spent TTL from an earlier one.
				const entry = byToken.get(existing);
				if (entry) {
					entry.expiresAt = now() + TTL_MS;
				}
				return existing;
			}
			const token = mintToken();
			byToken.set(token, { expiresAt: now() + TTL_MS, url });
			byUrl.set(url, token);
			return token;
		},
	};
};

export type ImageProxy = (token: string) => Promise<Response>;

const notFound = (): Response => new Response("not found\n", { status: 404 });
const upstreamError = (): Response =>
	new Response("upstream error\n", { status: 502 });

// Raster types only. image/svg+xml deliberately fails this check: it is the
// one image subtype that executes script when a browser navigates to it
// directly, and this proxy serves from our origin.
const RASTER_TYPES = new Set([
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

const isRasterImageType = (contentType: string): boolean => {
	const bare = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	return RASTER_TYPES.has(bare);
};

// Enforce the size cap on the actual bytes, not the declared content-length —
// a chunked response (no length header) must not stream unbounded. Exceeding
// the limit errors the stream, which truncates the response mid-flight.
export const byteLimit = (
	maxBytes: number
): TransformStream<Uint8Array, Uint8Array> => {
	let seen = 0;
	return new TransformStream({
		transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen > maxBytes) {
				controller.error(new Error("image proxy byte limit exceeded"));
				return;
			}
			controller.enqueue(chunk);
		},
	});
};

// dns.lookup takes no signal, so the request deadline is raced against it:
// a sender domain whose nameservers never answer must not hold the request
// past FETCH_TIMEOUT_MS.
const withDeadline = <T>(
	promise: Promise<T>,
	signal: AbortSignal
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});

// Resolve the upstream hostname into the addresses to try, in order. Every
// resolved address must be public: a mixed answer is a rebinding tell, not a
// host worth serving images from. IPv4 goes first regardless of resolver
// order: a server in a container often has no IPv6 route out.
const pinCandidates = async (
	hostname: string,
	resolve: ResolveHost,
	signal: AbortSignal
): Promise<string[]> => {
	const addresses = await withDeadline(resolve(hostname), signal);
	if (!addresses.every(isPublicAddress)) {
		return [];
	}
	return [
		...addresses.filter((address) => !isIPv6(address)),
		...addresses.filter((address) => isIPv6(address)),
	];
};

// The URL with its hostname swapped for the pinned address. The original
// hostname still goes out as the Host header and as the TLS server name, so
// virtual hosting works and the certificate is verified against the name
// the sender wrote, not the IP.
const pinnedUrl = (url: URL, address: string): string => {
	const pinned = new URL(url);
	const host = isIPv6(address) ? `[${address}]` : address;
	pinned.hostname = host;
	// The hostname setter silently ignores a value it cannot parse, which
	// would leave the fetch unpinned; refuse instead.
	if (pinned.hostname !== new URL(`https://${host}`).hostname) {
		throw new Error("image proxy could not pin the upstream address");
	}
	return pinned.toString();
};

// What the proxy asks of the function that fetches an image: `url` already
// has the checked address in place of the hostname; the name the sender wrote
// travels as the Host header and as the TLS server name.
export interface PinnedFetchInit {
	headers: { host: string };
	redirect: "error";
	signal: AbortSignal;
	tls: { serverName: string };
}

export type PinnedFetch = (
	url: string,
	init: PinnedFetchInit
) => Promise<Response>;

const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 399;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_MODIFIED = 304;

const firstHeader = (value: string | string[] | undefined): string =>
	(Array.isArray(value) ? value[0] : value) ?? "";

// The upstream's answer as a `Response` whose body streams as it arrives.
// Throws for what the proxy never passes on: a redirect, an encoded body.
const responseOf = (res: IncomingMessage): Response => {
	const status = res.statusCode ?? 0;
	if (status >= HTTP_REDIRECT_MIN && status <= HTTP_REDIRECT_MAX) {
		throw new Error("image proxy upstream redirected");
	}
	const encoding = firstHeader(res.headers["content-encoding"]).toLowerCase();
	if (encoding !== "" && encoding !== "identity") {
		throw new Error("image proxy upstream sent an encoded body");
	}
	const headers = new Headers();
	for (const name of ["content-length", "content-type"]) {
		const value = firstHeader(res.headers[name]);
		if (value !== "") {
			headers.set(name, value);
		}
	}
	if (status === HTTP_NO_CONTENT || status === HTTP_NOT_MODIFIED) {
		res.resume();
		return new Response(null, { headers, status });
	}
	return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
		headers,
		status,
	});
};

/**
 * A GET to an address-pinned https URL, on `node:https`: the global `fetch`
 * cannot connect to one address while checking the certificate against
 * another name. The socket goes to the address in `url`; the certificate must
 * be valid for `init.tls.serverName`, which is also what SNI and the Host
 * header carry. Nothing is followed: a redirect rejects. `ca` replaces the
 * system's trust store and is for tests.
 */
export const makePinnedFetch =
	(tlsOptions: { ca?: string } = {}): PinnedFetch =>
	(url, init) =>
		new Promise<Response>((resolve, reject) => {
			const req = https.request(
				url,
				{
					...tlsOptions,
					// One connection per image, closed after it: nothing is pooled
					// under the pinned address for a later request to reuse.
					agent: false,
					headers: {
						// The body is passed on as it arrives, so it must arrive
						// unencoded.
						"accept-encoding": "identity",
						host: init.headers.host,
					},
					method: "GET",
					servername: init.tls.serverName,
					signal: init.signal,
				},
				(res) => {
					try {
						resolve(responseOf(res));
					} catch (error) {
						res.destroy();
						reject(error);
					}
				}
			);
			req.on("error", reject);
			req.end();
		});

const pinnedFetch: PinnedFetch = makePinnedFetch();

// Fetch from each checked address in turn until one connects. A pinned fetch
// has no fallback of its own, so a host with one dead A record would
// otherwise 502 although its other checked addresses are healthy. All tries
// share the request deadline; once it passes, nothing more is tried.
const fetchPinned = async (
	url: URL,
	candidates: string[],
	fetchImpl: PinnedFetch,
	signal: AbortSignal
): Promise<Response> => {
	let lastError: unknown = new Error("image proxy has no address to try");
	for (const address of candidates) {
		try {
			// redirect: 'error' — a redirect could bounce to a host neither check
			// ever saw, so it is refused instead of followed. `pinnedFetch`
			// verifies the certificate against tls.serverName, not the IP, and
			// sends the host override; image-proxy.test.ts checks both against a
			// real TLS server.
			return await fetchImpl(pinnedUrl(url, address), {
				headers: { host: url.host },
				redirect: "error",
				signal,
				tls: { serverName: url.hostname },
			});
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError;
};

export const createImageProxy = (
	store: ImageProxyStore,
	fetchImpl: PinnedFetch = pinnedFetch,
	resolve: ResolveHost = resolveHost,
	timeoutMs: number = FETCH_TIMEOUT_MS
): ImageProxy => {
	return async (token) => {
		const raw = store.lookup(token);
		if (!raw) {
			return notFound();
		}
		const url = new URL(raw);
		let upstream: Response;
		// One deadline for the DNS lookup and the fetch together.
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const candidates = await pinCandidates(url.hostname, resolve, signal);
			if (candidates.length === 0) {
				// Logs neither the URL nor the resolved addresses: both are sender
				// infrastructure (see below).
				logger.warn("image proxy upstream has no public address");
				return upstreamError();
			}
			upstream = await fetchPinned(url, candidates, fetchImpl, signal);
		} catch {
			// Log carries no URL: the target embeds sender infrastructure and the
			// occasional tracking id.
			// A timeout during DNS is told apart from a failed connection.
			logger.warn(
				signal.aborted
					? "image proxy upstream timed out"
					: "image proxy upstream fetch failed"
			);
			return upstreamError();
		}
		const type = upstream.headers.get("content-type") ?? "";
		// The declared length is a fast reject; byteLimit below enforces the cap
		// on the real bytes for chunked/lying upstreams.
		const length = Number(upstream.headers.get("content-length") ?? "0");
		if (!(upstream.ok && isRasterImageType(type)) || length > MAX_IMAGE_BYTES) {
			logger.warn(
				{ status: upstream.status },
				"image proxy upstream not a usable image"
			);
			return upstreamError();
		}
		const headers = new Headers({
			"cache-control": "private, max-age=300",
			// Belt and braces against active content on our origin: no sniffing
			// away from the raster type, and a sandbox with no capabilities if a
			// browser ever navigates to this URL directly.
			"content-security-policy": "sandbox; default-src 'none'",
			"content-type": type,
			"x-content-type-options": "nosniff",
		});
		// No content-length forwarded: fetch transparently decompresses a
		// gzip/brotli-encoded upstream, so the header would describe the encoded
		// bytes and make browsers truncate the image. Chunked streaming is fine.
		// Streamed through, never buffered.
		return new Response(
			upstream.body?.pipeThrough(byteLimit(MAX_IMAGE_BYTES)) ?? null,
			{ headers }
		);
	};
};

const IMAGE_PROXY_PREFIX = "/image-proxy/";

/**
 * The route that redeems image-proxy tokens: `GET /image-proxy/<token>`.
 * Anything but a clean GET of a single token segment is a plain 404,
 * indistinguishable from an unknown or expired token. No `logAs`: the path is
 * the credential. A listener serves this route only when the user has turned
 * remote images on.
 */
export const imageProxyRoute = (proxy: ImageProxy): Route => ({
	handle: (req, url) => {
		const token = url.pathname.slice(IMAGE_PROXY_PREFIX.length);
		if (req.method === "GET" && token && !token.includes("/")) {
			return proxy(token);
		}
		return notFound();
	},
	path: IMAGE_PROXY_PREFIX,
});
