// E2E for preview_email against a REAL Stalwart, through the BUILT server:
// one HTML message that carries everything a sender can put into mail to
// reach beyond the mailbox (a script, event handlers, a frame, a form, remote
// images, a tracking pixel) next to what must still render (an inline cid
// image) and a real attachment.
//
// The server is started the way an agent starts it, over stdio and over
// HTTP, and driven with an MCP client: the tool and its viewer template are
// listed, the template is one self-contained document, and the preview is
// sanitised. The remote-image rule is checked against a sentinel: an HTTP
// server on loopback that the message's tracking pixel points at and that
// counts every request. The server child gets a clean environment (no
// HTTP_PROXY, no HTTPS_PROXY), so nothing it sends can go anywhere unseen.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	createAccount,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import { live } from "./support/env.ts";
import { importEmail, openMailSession } from "./support/mail.ts";
import {
	canListListeningTcpPorts,
	type HttpServer,
	listeningTcpSockets,
	type StdioServer,
	startHttpServer,
	startRawStdioServer,
	startStdioServer,
} from "./support/server.ts";
import { toolText } from "./support/tool-output.ts";

const VIEWER_URI = "ui://langmail/email-viewer";
const PREVIEW_META_KEY = "me.langmail/email-preview";
const VIEWER_MIME_TYPE = "text/html;profile=mcp-app";
const LOOPBACK = "127.0.0.1";
const REMOTE_HOST = "images.example.com";
const ORDER_LINK = "https://shop.example.com/order/42";
const RECEIVED_AT = new Date("2026-06-30T10:00:00Z");

const BASE64_LINE_RE = /.{1,76}/gu;
const IMG_SRC_RE = /<img\b[^>]*\ssrc="([^"]*)"/gu;
const ANY_URL_RE = /https?:\/\/[^\s"'<>\\)]+/gu;
const CSS_URL_RE = /url\(/iu;
const SCRIPT_TAG_RE = /<script\b[^>]*>/gu;
const MARKUP_LOAD_RE = /\s(?:src|href|srcset|action|data)\s*=/iu;
const TICKET_PATH_RE = /^\/attachments\/[\w-]{43}$/u;
const PROXY_PATH_RE = /^\/image-proxy\/[\w-]{43}$/u;
const STDIO_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d+$/u;
const REMOTE_IMAGES_OFF_NOTE =
	"3 image(s) the email loads from the sender's servers are left out of the preview: this server fetches such images only with LANGMAIL_MCP_ALLOW_REMOTE_IMAGES on; it is off.";

// Makes every name the image proxy looks up resolve to 127.0.0.1 in the
// server child (see the file).
const RESOLVE_TO_LOOPBACK = fileURLToPath(
	new URL("./support/resolve-to-loopback.mjs", import.meta.url)
);

const fixture = (name: string): Buffer =>
	readFileSync(new URL(`../src/attachments/fixtures/${name}`, import.meta.url));

const base64Lines = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64").match(BASE64_LINE_RE)?.join("\r\n") ??
	"";

// Everything in one body. `sentinel` is the loopback server the tracking
// pixel points at.
const ticketHtml = (sentinel: string): string =>
	[
		"<html><head>",
		"<style>.title { color: #333333; }</style>",
		"<script>window.stolen = document.cookie</script>",
		"</head><body>",
		'<h1 class="title" onclick="steal()">Your ticket for tonight</h1>',
		`<p><a href="${ORDER_LINK}" onclick="steal()" onmouseover="steal()">View your order</a></p>`,
		'<table><tr><td><img src="cid:qr@tickets.example.com" alt="QR code"></td></tr></table>',
		`<img src="https://${REMOTE_HOST}/hero.png" alt="Hero">`,
		`<img src="https://${REMOTE_HOST}/open.gif?u=42" width="1" height="1" alt="">`,
		`<img src="${sentinel}/pixel.gif?u=42" width="1" height="1" alt="">`,
		`<iframe src="${sentinel}/frame"></iframe>`,
		`<form action="${sentinel}/submit"><input name="q"></form>`,
		"</body></html>",
	].join("\r\n");

const ticketMime = (address: string, run: number, sentinel: string): string =>
	[
		"From: Box Office <tickets@example.com>",
		`To: ${address}`,
		"Subject: Your ticket for tonight",
		`Message-ID: <ticket-${run}@mcp-preview-e2e>`,
		"Date: Tue, 30 Jun 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="mixed-b"',
		"",
		"--mixed-b",
		'Content-Type: multipart/related; boundary="related-b"',
		"",
		"--related-b",
		"Content-Type: text/html; charset=utf-8",
		"",
		ticketHtml(sentinel),
		"--related-b",
		"Content-Type: image/png",
		"Content-Transfer-Encoding: base64",
		"Content-ID: <qr@tickets.example.com>",
		'Content-Disposition: inline; filename="qr.png"',
		"",
		base64Lines(fixture("pixel.png")),
		"--related-b--",
		"--mixed-b",
		'Content-Type: application/pdf; name="ticket.pdf"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="ticket.pdf"',
		"",
		base64Lines(fixture("sample.pdf")),
		"--mixed-b--",
		"",
	].join("\r\n");

const plainMime = (address: string, run: number): string =>
	[
		"From: Box Office <tickets@example.com>",
		`To: ${address}`,
		"Subject: Doors open at seven",
		`Message-ID: <plain-${run}@mcp-preview-e2e>`,
		"Date: Tue, 30 Jun 2026 10:05:00 +0000",
		"",
		"Seats: A1 & A2 <balcony>",
	].join("\r\n");

// A server that answers every request and remembers it. With remote images
// off, nothing may ever reach it.
interface Sentinel {
	origin: string;
	requests: string[];
	stop: () => Promise<void>;
}

const startSentinel = async (): Promise<Sentinel> => {
	const requests: string[] = [];
	const server: Server = createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "content-type": "image/gif" });
		res.end("GIF89a");
	});
	await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://${LOOPBACK}:${port}`,
		requests,
		stop: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
};

interface PreviewResult {
	_meta?: Record<string, { html?: string; renderSource?: string }>;
	content?: unknown;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
}

const preview = async (client: Client, id: string): Promise<PreviewResult> =>
	(await client.callTool({
		arguments: { id },
		name: "preview_email",
	})) as PreviewResult;

const previewHtml = (result: PreviewResult): string =>
	result._meta?.[PREVIEW_META_KEY]?.html ?? "";

const imageSources = (html: string): string[] =>
	[...html.matchAll(IMG_SRC_RE)].map((match) => match[1] ?? "");

// Every http(s) URL anywhere in a tool result: text, structured content and
// the document for the viewer.
const everyUrl = (result: PreviewResult): string[] =>
	[...JSON.stringify(result).matchAll(ANY_URL_RE)].map((match) => match[0]);

// What the tool definition and the template must say, on any transport.
const expectPreviewToolListed = async (client: Client): Promise<void> => {
	const { tools } = await client.listTools();
	expect(tools.slice(0, 4).map((listed) => listed.name)).toEqual([
		"search_emails",
		"get_email",
		"preview_email",
		"get_thread",
	]);
	const tool = tools.find((candidate) => candidate.name === "preview_email");
	expect(tool).toMatchObject({
		_meta: {
			ui: { resourceUri: VIEWER_URI },
			"ui/resourceUri": VIEWER_URI,
		},
		annotations: {
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
			readOnlyHint: true,
		},
		title: "Preview email",
	});
	expect(tool?.description).toContain(
		"Show one email to the user as a rendered document, inline in the conversation."
	);
	expect(tool?.inputSchema.required).toEqual(["id"]);
	expect(tool?.outputSchema?.required).toEqual([
		"attachmentCount",
		"date",
		"from",
		"renderSource",
		"subject",
		"tags",
	]);
};

// The template a host renders: one document, nothing to load from anywhere.
const expectSelfContainedViewer = async (
	client: Client,
	origin: string
): Promise<void> => {
	const read = await client.readResource({ uri: VIEWER_URI });
	expect(read.contents).toHaveLength(1);
	const [content] = read.contents as {
		_meta?: unknown;
		mimeType?: string;
		text?: string;
		uri: string;
	}[];
	expect(content?.uri).toBe(VIEWER_URI);
	expect(content?.mimeType).toBe(VIEWER_MIME_TYPE);
	// The view may load from this server and from nowhere else.
	expect(content?._meta).toEqual({
		ui: { csp: { resourceDomains: [origin] }, prefersBorder: true },
	});
	const html = content?.text ?? "";
	expect(html.startsWith("<!doctype html>")).toBe(true);
	// One inline module script, and no markup that loads anything: no script
	// or style URL, no image, no frame source.
	expect(html.match(SCRIPT_TAG_RE)).toEqual(['<script type="module">']);
	const markup = html.slice(0, html.indexOf('<script type="module">'));
	expect(markup).not.toMatch(MARKUP_LOAD_RE);
	expect(markup).not.toContain("<link");
	expect(markup).not.toContain("@import");
	expect(markup).not.toMatch(CSS_URL_RE);
	expect(html).toContain(PREVIEW_META_KEY);
	// The App SDK is inlined: the script is far larger than the view's own
	// code.
	expect(html.length).toBeGreaterThan(100_000);
};

// What every preview of the ticket must be, whatever the remote-image
// setting: metadata for the model, a sanitised document for the user, and
// the inline image served from the message itself.
const expectSanitisedTicket = async (
	result: PreviewResult,
	origin: string
): Promise<string> => {
	expect(result.isError).toBeFalsy();
	expect(result.structuredContent).toEqual({
		// The PDF. The inline QR is part of the rendering, not a document.
		attachmentCount: 1,
		date: "2026-06-30T10:00:00Z",
		from: "Box Office <tickets@example.com>",
		renderSource: "html",
		subject: "Your ticket for tonight",
		tags: [],
	});
	// The body is for the user: none of it is in what the model reads.
	const text = toolText(result);
	expect(text).toContain(
		'Preview of "Your ticket for tonight" prepared (html rendering).'
	);
	expect(text).not.toContain("<h1");
	expect(text).not.toContain("<table");

	const html = previewHtml(result);
	expect(html).toContain("Your ticket for tonight</h1>");
	expect(html).toContain(".title { color: #333333; }");
	expect(html).toContain(`href="${ORDER_LINK}"`);
	// Nothing that runs, frames or submits.
	for (const gone of [
		"<script",
		"window.stolen",
		"onclick",
		"onmouseover",
		"steal()",
		"<iframe",
		"<form",
		"<input",
	]) {
		expect(html).not.toContain(gone);
	}

	// The inline image is a link to the message's own part on this server.
	const [inline] = imageSources(html);
	const inlineUrl = new URL(inline ?? "");
	expect(inlineUrl.origin).toBe(origin);
	expect(inlineUrl.pathname).toMatch(TICKET_PATH_RE);
	const image = await fetch(inlineUrl);
	expect(image.status).toBe(200);
	expect(image.headers.get("content-type")).toBe("image/png");
	expect(
		Buffer.from(await image.arrayBuffer()).equals(fixture("pixel.png"))
	).toBe(true);
	return html;
};

// Remote images off: nothing of them is left to load, and loading everything
// that is left reaches no one but this server.
const expectNoRemoteImages = async (
	result: PreviewResult,
	origin: string,
	sentinel: Sentinel
): Promise<void> => {
	const html = await expectSanitisedTicket(result, origin);
	expect(imageSources(html)).toHaveLength(1);
	expect(html).not.toContain(REMOTE_HOST);
	expect(html).not.toContain(sentinel.origin);
	expect(html).not.toContain("image-proxy");
	expect(html).not.toMatch(CSS_URL_RE);
	expect(toolText(result)).toContain(REMOTE_IMAGES_OFF_NOTE);

	// The only URLs in the whole result: the inline image's link, the link
	// the user may click, and this server's own origin, which the email
	// document's CSP names as the one place it may load an image from.
	const urls = everyUrl(result);
	expect(urls.filter((url) => url !== ORDER_LINK)).toEqual([
		...imageSources(html),
		origin,
	]);
	// Load everything the document would load. (The order link is not a
	// load: the viewer hands a click to the host.)
	for (const src of imageSources(html)) {
		expect((await fetch(src)).status).toBe(200);
	}
	expect(sentinel.requests).toEqual([]);
};

// Remote images on, with every name resolving to loopback in the server:
// https images become proxy links, the proxy refuses the address, and the
// loopback sentinel is never contacted.
const expectProxiedButRefused = async (
	result: PreviewResult,
	origin: string,
	sentinel: Sentinel,
	stderr: () => string
): Promise<void> => {
	const html = await expectSanitisedTicket(result, origin);
	expect(toolText(result)).not.toContain("LANGMAIL_MCP");
	const sources = imageSources(html);
	// The inline image, the hero and the https pixel. The pixel on
	// http://127.0.0.1 is not a public https address: no link is minted.
	expect(sources).toHaveLength(3);
	expect(html).not.toContain(REMOTE_HOST);
	expect(html).not.toContain(sentinel.origin);
	const proxied = sources.slice(1).map((src) => new URL(src));
	for (const link of proxied) {
		expect(link.origin).toBe(origin);
		expect(link.pathname).toMatch(PROXY_PATH_RE);
	}
	expect(new Set(proxied.map((link) => link.pathname)).size).toBe(2);

	for (const link of proxied) {
		const res = await fetch(link);
		expect(res.status).toBe(502);
		expect(await res.text()).toBe("upstream error\n");
	}
	// Refused for the address, before any connection.
	expect(
		stderr()
			.split("\n")
			.filter((line) =>
				line.includes('"msg":"image proxy upstream has no public address"')
			)
	).toHaveLength(2);
	expect(stderr()).not.toContain(REMOTE_HOST);
	// A token nobody minted is a plain 404.
	const unknown = await fetch(`${origin}/image-proxy/${"A".repeat(43)}`);
	expect(unknown.status).toBe(404);
	expect(sentinel.requests).toEqual([]);
};

live("preview_email against live Stalwart, through the built server", () => {
	const run = Date.now();
	let account: TestAccount;
	let sentinel: Sentinel;
	let ticketId: string;
	let plainId: string;

	beforeAll(async () => {
		sentinel = await startSentinel();
		account = await createAccount({
			localPart: uniqueLocalPart("mcp-preview-e2e"),
		});
		const session = await openMailSession(account.authorization);
		ticketId = await importEmail(session, {
			raw: ticketMime(account.address, run, sentinel.origin),
			receivedAt: RECEIVED_AT,
		});
		plainId = await importEmail(session, {
			raw: plainMime(account.address, run),
			receivedAt: RECEIVED_AT,
		});
	});

	afterAll(async () => {
		await sentinel?.stop();
		await destroyCreatedAccounts();
	});

	describe("over stdio, as installed (remote images off)", () => {
		let server: StdioServer;

		beforeAll(async () => {
			server = await startStdioServer(account);
		});

		afterAll(async () => {
			await server?.stop();
		});

		test("lists preview_email third, bound to the viewer template", async () => {
			await expectPreviewToolListed(server.client);
		});

		test("lists the viewer template without naming an origin", async () => {
			const { resources } = await server.client.listResources();
			expect(resources).toEqual([
				{
					_meta: { ui: { prefersBorder: true } },
					description:
						"Inline full-fidelity rendering of one email, fed by the preview_email tool.",
					mimeType: VIEWER_MIME_TYPE,
					name: "email-viewer",
					uri: VIEWER_URI,
				},
			]);
		});

		test("serves the viewer as one self-contained document that may load from the loopback listener only", async () => {
			const read = await server.client.readResource({ uri: VIEWER_URI });
			const meta = (read.contents[0] as { _meta?: unknown })._meta as {
				ui: { csp: { resourceDomains: string[] } };
			};
			const [origin] = meta.ui.csp.resourceDomains;
			expect(origin).toMatch(STDIO_ORIGIN_RE);
			await expectSelfContainedViewer(server.client, origin as string);
		});

		test("shows the ticket sanitised, with its inline image and without its remote ones; nothing is fetched from anyone", async () => {
			const result = await preview(server.client, ticketId);
			const origin = new URL(imageSources(previewHtml(result))[0] ?? "").origin;
			expect(origin).toMatch(STDIO_ORIGIN_RE);
			await expectNoRemoteImages(result, origin, sentinel);
			// No image-proxy route exists on the listener that serves the links.
			const res = await fetch(`${origin}/image-proxy/${"A".repeat(43)}`);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
			expect(sentinel.requests).toEqual([]);
			expect(server.stderr()).toBe("");
		});

		test("falls back to the escaped text of a message without an HTML part", async () => {
			const result = await preview(server.client, plainId);
			expect(result.structuredContent).toMatchObject({
				attachmentCount: 0,
				renderSource: "text",
				subject: "Doors open at seven",
			});
			expect(previewHtml(result)).toContain(
				"Seats: A1 &amp; A2 &lt;balcony&gt;"
			);
			expect(everyUrl(result)).toEqual([]);
		});

		test("reports a message that does not exist", async () => {
			const result = await preview(server.client, "zzzzzzzzzz");
			expect(result.isError).toBe(true);
			expect(toolText(result)).toBe("Email not found: zzzzzzzzzz");
		});
	});

	test.skipIf(!canListListeningTcpPorts)(
		"over stdio, no TCP port opens for the listings or a text preview; reading the viewer opens the one loopback port its CSP names",
		async () => {
			const raw = await startRawStdioServer(account);
			try {
				const tools = await raw.request("tools/list");
				expect(JSON.stringify(tools)).toContain('"name":"preview_email"');
				const resources = await raw.request("resources/list");
				expect(JSON.stringify(resources)).toContain(VIEWER_URI);
				expect(listeningTcpSockets(raw.pid)).toEqual([]);

				// A text preview carries no link, so it needs no listener either.
				const text = await raw.request("tools/call", {
					arguments: { id: plainId },
					name: "preview_email",
				});
				expect(JSON.stringify(text)).toContain("text rendering");
				expect(listeningTcpSockets(raw.pid)).toEqual([]);

				const read = (await raw.request("resources/read", {
					uri: VIEWER_URI,
				})) as {
					result?: {
						contents?: {
							_meta?: { ui?: { csp?: { resourceDomains?: string[] } } };
						}[];
					};
				};
				const sockets = listeningTcpSockets(raw.pid);
				expect(sockets).toHaveLength(1);
				expect(sockets[0]?.address).toBe(LOOPBACK);
				expect(
					read.result?.contents?.[0]?._meta?.ui?.csp?.resourceDomains
				).toEqual([`http://${LOOPBACK}:${sockets[0]?.port}`]);

				// The preview's links live on that same listener: still one port.
				const shown = await raw.request("tools/call", {
					arguments: { id: ticketId },
					name: "preview_email",
				});
				expect(JSON.stringify(shown)).toContain(
					`http://${LOOPBACK}:${sockets[0]?.port}/attachments/`
				);
				expect(listeningTcpSockets(raw.pid)).toEqual(sockets);
				expect(sentinel.requests).toEqual([]);
			} finally {
				await raw.stop();
			}
		}
	);

	describe("over HTTP, as installed (remote images off)", () => {
		let server: HttpServer;

		beforeAll(async () => {
			server = await startHttpServer(account);
		});

		afterAll(async () => {
			await server?.stop();
		});

		test("lists preview_email third, bound to the viewer template", async () => {
			await expectPreviewToolListed(server.client);
		});

		test("lists the viewer template with the server's own origin as the only one it may load from", async () => {
			const { resources } = await server.client.listResources();
			expect(resources).toEqual([
				{
					_meta: {
						ui: {
							csp: { resourceDomains: [server.baseUrl] },
							prefersBorder: true,
						},
					},
					description:
						"Inline full-fidelity rendering of one email, fed by the preview_email tool.",
					mimeType: VIEWER_MIME_TYPE,
					name: "email-viewer",
					uri: VIEWER_URI,
				},
			]);
		});

		test("serves the viewer as one self-contained document", async () => {
			await expectSelfContainedViewer(server.client, server.baseUrl);
		});

		test("shows the ticket sanitised, with its inline image and without its remote ones; nothing is fetched from anyone", async () => {
			const result = await preview(server.client, ticketId);
			await expectNoRemoteImages(result, server.baseUrl, sentinel);
			// No image-proxy route is mounted next to /mcp.
			const res = await fetch(
				`${server.baseUrl}/image-proxy/${"A".repeat(43)}`
			);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
			expect(sentinel.requests).toEqual([]);
		});

		test("the template's origin follows MCP_PUBLIC_URL", async () => {
			const behindProxy = await startHttpServer(account, {
				env: { MCP_PUBLIC_URL: "https://mcp.example.com/" },
			});
			try {
				const { resources } = await behindProxy.client.listResources();
				expect(resources[0]?._meta).toEqual({
					ui: {
						csp: { resourceDomains: ["https://mcp.example.com"] },
						prefersBorder: true,
					},
				});
				const result = await preview(behindProxy.client, ticketId);
				const [inline] = imageSources(previewHtml(result));
				expect(inline?.startsWith("https://mcp.example.com/attachments/")).toBe(
					true
				);
			} finally {
				await behindProxy.stop();
			}
		});
	});

	describe("with LANGMAIL_MCP_ALLOW_REMOTE_IMAGES=1", () => {
		const env = {
			LANGMAIL_MCP_ALLOW_REMOTE_IMAGES: "1",
			NODE_OPTIONS: `--import=${RESOLVE_TO_LOOPBACK}`,
		};

		test("over stdio, https images become proxy links, and the proxy refuses a host that resolves to a loopback address", async () => {
			const server = await startStdioServer(account, { env });
			try {
				const result = await preview(server.client, ticketId);
				const origin = new URL(imageSources(previewHtml(result))[0] ?? "")
					.origin;
				expect(origin).toMatch(STDIO_ORIGIN_RE);
				await expectProxiedButRefused(result, origin, sentinel, server.stderr);
			} finally {
				await server.stop();
			}
		});

		test("over HTTP, https images become proxy links, and the proxy refuses a host that resolves to a loopback address", async () => {
			const server = await startHttpServer(account, { env });
			try {
				const result = await preview(server.client, ticketId);
				await expectProxiedButRefused(
					result,
					server.baseUrl,
					sentinel,
					server.stderr
				);
			} finally {
				await server.stop();
			}
		});
	});
});
