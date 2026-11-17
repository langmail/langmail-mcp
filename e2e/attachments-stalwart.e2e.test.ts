// E2E for the attachments feature against a REAL Stalwart: seed a message
// carrying both a genuine PDF attachment and a cid-inline PNG, then drive the
// real surfaces end to end — get_email's attachments section,
// download_attachment's capability URL, and the /attachments/<ticket> route
// streaming the blob bytes back out — plus the negative paths (tampered
// token, blobId on the wrong message) and the context-hygiene guarantee
// ("bytes never enter the conversation", encoded as a test).
//
// Seeding is deterministic: build the raw RFC 5322 MIME from the fixtures in
// `src/attachments/fixtures/`, then import it into the Inbox — no SMTP timing.
//
// The first block runs the tools and the route in this process, on their live
// deps, with the account's app-password credential as the token and the same
// request handler (guard included) the HTTP transport serves. The blocks
// after it start the built server the way an agent does, over stdio and over
// HTTP, call the tools through an MCP client and move the bytes with a plain
// `fetch`, as `curl` would.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createRequestGuard } from "../src/http/guard.ts";
import { createFetchHandler, type FetchHandler } from "../src/http/routes.ts";
import { emailQuery } from "../src/jmap/index.ts";
import { createRuntime } from "../src/mcp/handler.ts";
import { linkRoutes } from "../src/mcp/links.ts";
import {
	type DownloadAttachmentDeps,
	downloadAttachment,
	makeLiveDeps as makeDownloadAttachmentDeps,
} from "../src/tools/download-attachment.ts";
import { downloadEmail } from "../src/tools/download-email.ts";
import {
	type GetEmailDeps,
	getEmail,
	makeLiveDeps as makeGetEmailDeps,
} from "../src/tools/get-email.ts";
import {
	makeLiveDeps as makeSearchEmailsDeps,
	type SearchEmailsDeps,
	searchEmails,
} from "../src/tools/search-emails.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	openMailSession,
} from "./support/mail.ts";
import {
	canListListeningTcpPorts,
	type HttpServer,
	listeningTcpSockets,
	type StdioServer,
	startHttpServer,
	startRawStdioServer,
	startStdioServer,
} from "./support/server.ts";
import { pollUntil, untilIndexed } from "./support/wait.ts";

const PUBLIC = "https://mcp.example.com";
const PUBLIC_HOST = "mcp.example.com";
const LOOPBACK = "127.0.0.1";

// Base64 runs longer than this are treated as payload leakage into the
// model-visible result — the thing these tools exist to prevent.
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{100,}/u;
const DOWNLOAD_URL_RE = /^(https:\/\/\S+\/attachments\/\S+)$/mu;
// What the built server hands out: plain HTTP under its own address.
const SERVED_DOWNLOAD_URL_RE = /^(http:\/\/\S+\/attachments\/[\w-]+)$/mu;
const UPLOAD_URL_RE = /'(http:\/\/\S+\/attachments\/uploads\/[\w-]+)'/u;
const STDIO_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:(\d+)$/u;
const PDF_LINE_RE =
	/^\s*\d+\. invoice\.pdf — application\/pdf, 602 B — blobId: (\S+)$/mu;
const PNG_LINE_RE =
	/^\s*\d+\. logo\.png — image\/png, 70 B — inline — blobId: (\S+)$/mu;
const BASE64_LINE_RE = /.{1,76}/gu;

// Full-text indexing lags the import, and other suites load the same server.
const INDEX_BUDGET_MS = 30_000;
const STOPPED_BUDGET_MS = 10_000;

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
	new Uint8Array(
		readFileSync(
			new URL(`../src/attachments/fixtures/${name}`, import.meta.url)
		)
	);

const base64Lines = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64").match(BASE64_LINE_RE)?.join("\r\n") ??
	"";

// The message with both fixture parts: a cid-inline PNG referenced from the
// HTML body (inside multipart/related) and a genuine PDF document.
const invoiceMime = (address: string, run: number): string =>
	[
		"From: Sender <sender@example.com>",
		`To: ${address}`,
		"Subject: Invoice June 2026",
		`Message-ID: <invoice-${run}@mcp-att-e2e>`,
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
		'<html><body><p>Invoice attached.</p><img src="cid:logo@langmail"></body></html>',
		"--related-b",
		"Content-Type: image/png",
		"Content-Transfer-Encoding: base64",
		"Content-ID: <logo@langmail>",
		'Content-Disposition: inline; filename="logo.png"',
		"",
		base64Lines(fixture("pixel.png")),
		"--related-b--",
		"--mixed-b",
		'Content-Type: application/pdf; name="invoice.pdf"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="invoice.pdf"',
		"",
		base64Lines(fixture("sample.pdf")),
		"--mixed-b--",
		"",
	].join("\r\n");

const plainMime = (address: string, run: number): string =>
	[
		"From: Sender <sender@example.com>",
		`To: ${address}`,
		"Subject: No files here",
		`Message-ID: <plain-${run}@mcp-att-e2e>`,
		"Date: Tue, 30 Jun 2026 10:05:00 +0000",
		"",
		"Just text.",
	].join("\r\n");

const RECEIVED_AT = new Date("2026-06-30T10:00:00Z");

interface Seeded {
	account: TestAccount;
	plainId: string;
	session: MailSession;
	withAttachmentsId: string;
}

// A fresh account with the invoice (PDF + inline PNG) and a plain message in
// its Inbox.
const seedAccount = async (name: string, run: number): Promise<Seeded> => {
	const account = await createAccount({ localPart: uniqueLocalPart(name) });
	const session = await openMailSession(account.authorization);
	const withAttachmentsId = await importEmail(session, {
		raw: invoiceMime(account.address, run),
		receivedAt: RECEIVED_AT,
	});
	const plainId = await importEmail(session, {
		raw: plainMime(account.address, run),
		receivedAt: RECEIVED_AT,
	});
	return { account, plainId, session, withAttachmentsId };
};

describe("attachment metadata line matchers", () => {
	test("match both get_email attachment lines and indented search hit attachment lines", () => {
		expect(
			"1. invoice.pdf — application/pdf, 602 B — blobId: Gpdf".match(
				PDF_LINE_RE
			)?.[1]
		).toBe("Gpdf");
		expect(
			"   1. invoice.pdf — application/pdf, 602 B — blobId: Gpdf".match(
				PDF_LINE_RE
			)?.[1]
		).toBe("Gpdf");
	});
});

live(
	"attachments against live Stalwart — metadata, capability URL, blob streaming",
	() => {
		const run = Date.now();
		let address: string;
		let token: string;
		let pdfBytes: Uint8Array<ArrayBuffer>;
		let withAttachmentsId: string;
		let plainId: string;
		let emailDeps: GetEmailDeps;
		let searchDeps: SearchEmailsDeps;
		let dlDeps: DownloadAttachmentDeps;
		let routes: { fetch: FetchHandler };

		// The request a reverse proxy in front of the server would pass on: the
		// public URL's host, no Origin, no credential.
		const get = (url: string): Promise<Response> =>
			routes.fetch(new Request(url, { headers: { host: PUBLIC_HOST } }));

		beforeAll(async () => {
			const seeded = await seedAccount("mcp-att-e2e", run);
			({ plainId, withAttachmentsId } = seeded);
			address = seeded.account.address;
			token = seeded.account.authorization;
			pdfBytes = fixture("sample.pdf");

			// The runtime the HTTP transport builds, reached under a public URL.
			const { config } = loadConfig(
				{
					MCP_AUTH_TOKEN: "an-e2e-token-nobody-presents",
					MCP_PUBLIC_URL: PUBLIC,
					STALWART_PASSWORD: seeded.account.secret,
					STALWART_URL: ADMIN_URL,
					STALWART_USERNAME: address,
				},
				["--http"]
			);
			const runtime = createRuntime(config);

			// The seeds the search tests look for are awaited, not raced.
			const { accountId, apiUrl, authorization } = seeded.session;
			await untilIndexed(
				() =>
					emailQuery({
						accountId,
						apiUrl,
						authorization,
						filters: { text: ["Invoice", "text"] },
						limit: 10,
					}),
				(found) =>
					[withAttachmentsId, plainId].every((id) => found.includes(id)),
				"the two seeded invoices",
				INDEX_BUDGET_MS
			);

			emailDeps = makeGetEmailDeps(runtime.jmapLive);
			searchDeps = makeSearchEmailsDeps(runtime.jmapLive);
			dlDeps = makeDownloadAttachmentDeps(
				runtime.jmapLive,
				runtime.tickets,
				runtime.publicUrl
			);
			expect(await runtime.publicUrl()).toBe(PUBLIC);
			// The real route handler behind the real guard, dispatched directly — no
			// listener needed.
			routes = {
				fetch: createFetchHandler(linkRoutes(runtime), {
					guard: createRequestGuard({ host: LOOPBACK, publicUrl: PUBLIC }),
				}),
			};
		});

		afterAll(async () => {
			await destroyCreatedAccounts();
		});

		test("get_email lists the PDF as a document and the cid PNG as inline, with real names/types/sizes", async () => {
			const result = await getEmail(emailDeps, {
				args: { id: withAttachmentsId },
				token,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain("Attachments (2):");
			expect(txt).toMatch(PDF_LINE_RE);
			expect(txt).toMatch(PNG_LINE_RE);
		});

		test("search_emails lists the PDF metadata and its blobId is directly redeemable", async () => {
			const result = await searchEmails(searchDeps, {
				args: { limit: 10, query: "Invoice" },
				token,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain(withAttachmentsId);
			expect(txt).toContain("snippet:");
			expect(txt).toMatch(PDF_LINE_RE);
			expect(txt).not.toMatch(PNG_LINE_RE);

			const blobId = txt.match(PDF_LINE_RE)?.[1];
			expect(blobId).toBeDefined();
			const download = await downloadAttachment(dlDeps, {
				args: { blobId: blobId as string, emailId: withAttachmentsId },
				token,
			});
			expect(download.isError).toBeUndefined();
			expect(download.content[0]?.text ?? "").toContain(
				"invoice.pdf (application/pdf, 602 B)"
			);
		});

		test("multi-term search ranks the message matching more terms first, with matched counts", async () => {
			// "Invoice June text": the invoice message matches "Invoice"+"June" (2/3),
			// the plain message ("Just text.") matches only "text" (1/3). Both were
			// imported with the same receivedAt, so only ranking makes the order
			// deterministic.
			const result = await searchEmails(searchDeps, {
				args: { limit: 10, query: "Invoice June text" },
				token,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain(withAttachmentsId);
			expect(txt).toContain(plainId);
			expect(txt.indexOf(withAttachmentsId)).toBeLessThan(txt.indexOf(plainId));
			expect(txt).toContain("matched: 2/3 terms");
			expect(txt).toContain("matched: 1/3 terms");
		});

		test("download_attachment mints a URL whose GET streams back the exact fixture bytes", async () => {
			const detail = await getEmail(emailDeps, {
				args: { id: withAttachmentsId },
				token,
			});
			const blobId = (detail.content[0]?.text ?? "").match(PDF_LINE_RE)?.[1];
			expect(blobId).toBeDefined();

			const result = await downloadAttachment(dlDeps, {
				args: { blobId: blobId as string, emailId: withAttachmentsId },
				token,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain("invoice.pdf (application/pdf, 602 B)");
			const url = txt.match(DOWNLOAD_URL_RE)?.[1];
			expect(url).toBeDefined();

			const res = await get(url as string);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/pdf");
			expect(res.headers.get("content-disposition")).toContain(
				'filename="invoice.pdf"'
			);
			const body = new Uint8Array(await res.arrayBuffer());
			expect(body).toEqual(pdfBytes);
		});

		test("download_email mints a URL whose GET streams back the exact raw message as message/rfc822", async () => {
			const result = await downloadEmail(dlDeps, {
				args: { emailId: plainId },
				token,
			});
			expect(result.isError).toBeUndefined();
			const txt = result.content[0]?.text ?? "";
			expect(txt).toContain("No files here.eml (message/rfc822,");
			const url = txt.match(DOWNLOAD_URL_RE)?.[1];
			expect(url).toBeDefined();

			const res = await get(url as string);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("message/rfc822");
			expect(res.headers.get("content-disposition")).toContain(
				'filename="No files here.eml"'
			);
			expect(await res.text()).toBe(plainMime(address, run));
		});

		test("a tampered token is a plain 404", async () => {
			const result = await downloadAttachment(dlDeps, {
				args: {
					blobId: (
						(
							await getEmail(emailDeps, {
								args: { id: withAttachmentsId },
								token,
							})
						).content[0]?.text ?? ""
					).match(PDF_LINE_RE)?.[1] as string,
					emailId: withAttachmentsId,
				},
				token,
			});
			const url = (result.content[0]?.text ?? "").match(
				DOWNLOAD_URL_RE
			)?.[1] as string;
			// Flip the last token character.
			const flipped = url.slice(0, -1) + (url.endsWith("A") ? "B" : "A");
			const res = await get(flipped);
			expect(res.status).toBe(404);
		});

		test("requesting message A's blobId under message B's id is a tool error", async () => {
			const blobId = (
				(await getEmail(emailDeps, { args: { id: withAttachmentsId }, token }))
					.content[0]?.text ?? ""
			).match(PDF_LINE_RE)?.[1] as string;
			const result = await downloadAttachment(dlDeps, {
				args: { blobId, emailId: plainId },
				token,
			});
			expect(result.isError).toBe(true);
		});

		test("context hygiene: tool results stay small and never carry the bytes", async () => {
			const detail = await getEmail(emailDeps, {
				args: { id: withAttachmentsId },
				token,
			});
			const detailTxt = detail.content[0]?.text ?? "";
			const blobId = detailTxt.match(PDF_LINE_RE)?.[1] as string;
			const download = await downloadAttachment(dlDeps, {
				args: { blobId, emailId: withAttachmentsId },
				token,
			});
			const downloadTxt = download.content[0]?.text ?? "";

			for (const txt of [detailTxt, downloadTxt]) {
				expect(txt.length).toBeLessThan(2048);
				expect(txt).not.toMatch(BASE64_RUN_RE);
			}
		});
	}
);

// --- the built server, as an agent runs it ---------------------------------

interface ToolAnswer {
	isError: boolean;
	text: string;
}

type ToolCaller = (
	name: string,
	args: Record<string, unknown>
) => Promise<ToolAnswer>;

const toolCaller =
	(server: Pick<StdioServer, "client">): ToolCaller =>
	async (name, args) => {
		const result = await server.client.callTool({ arguments: args, name });
		const content = result.content as { text?: string }[];
		return {
			isError: result.isError === true,
			text: content.map((part) => part.text ?? "").join("\n"),
		};
	};

// Asks the server for the seeded PDF's download link, the way an agent gets
// there: read the message, then call download_attachment with what it lists.
const pdfDownloadUrl = async (
	call: ToolCaller,
	emailId: string
): Promise<string> => {
	const detail = await call("get_email", { id: emailId });
	expect(detail.isError).toBe(false);
	const blobId = detail.text.match(PDF_LINE_RE)?.[1];
	expect(blobId).toBeDefined();
	const download = await call("download_attachment", { blobId, emailId });
	expect(download.isError).toBe(false);
	expect(download.text).toContain("invoice.pdf (application/pdf, 602 B)");
	expect(download.text).not.toMatch(BASE64_RUN_RE);
	const url = download.text.match(SERVED_DOWNLOAD_URL_RE)?.[1];
	expect(url).toBeDefined();
	return url as string;
};

const flipLast = (url: string): string =>
	url.slice(0, -1) + (url.endsWith("A") ? "B" : "A");

const bytesOf = async (res: Response): Promise<Uint8Array> =>
	new Uint8Array(await res.arrayBuffer());

// Asks for one upload link, PUTs the fixture PDF to it as `curl -T` would,
// and reads the stored blob back from Stalwart with the account's own
// credential. What becomes of the blob in a draft is the drafts suite's to
// prove; here the contract ends at "the bytes are in the mailbox's blob
// store under the blobId the PUT answered with".
const uploadPdf = async (
	call: ToolCaller,
	session: MailSession,
	origin: string
): Promise<void> => {
	const pdfBytes = fixture("sample.pdf");
	const answer = await call("upload_attachments", {
		files: [{ filename: "scan.pdf", sizeBytes: pdfBytes.byteLength }],
	});
	expect(answer.isError).toBe(false);
	expect(answer.text).toContain("Upload URLs for 1 of 1 file(s)");
	expect(answer.text).toContain("scan.pdf (application/pdf)");
	const url = answer.text.match(UPLOAD_URL_RE)?.[1] as string;
	expect(url).toBeDefined();
	expect(url.startsWith(`${origin}/attachments/uploads/`)).toBe(true);

	// No Authorization header: the link is the credential. The Content-Type
	// a client sends is ignored; the type was pinned when the link was made.
	const put = (): Promise<Response> =>
		fetch(url, {
			body: pdfBytes,
			headers: { "content-type": "text/plain" },
			method: "PUT",
		});
	const res = await put();
	expect(res.status).toBe(200);
	const stored = (await res.json()) as {
		blobId: string;
		filename: string;
		mimeType: string;
		next: string;
		size: number;
	};
	expect(stored.filename).toBe("scan.pdf");
	expect(stored.mimeType).toBe("application/pdf");
	expect(stored.size).toBe(pdfBytes.byteLength);
	expect(stored.next).toContain(stored.blobId);

	// Single use: the same link takes nothing more.
	const again = await put();
	expect(again.status).toBe(404);
	expect(((await again.json()) as { error: string }).error).toBe("not_found");

	// The bytes are in the account's blob store, unchanged.
	const blob = await fetch(
		session.downloadUrl
			.replace("{accountId}", session.accountId)
			.replace("{blobId}", stored.blobId)
			.replace("{name}", "scan.pdf")
			.replace("{type}", encodeURIComponent("application/pdf")),
		{ headers: { authorization: session.authorization } }
	);
	expect(blob.status).toBe(200);
	expect(await bytesOf(blob)).toEqual(pdfBytes);
};

const refusesConnections = async (url: string): Promise<boolean> => {
	try {
		await fetch(url);
		return false;
	} catch {
		return true;
	}
};

const listenOnFreePort = (): Promise<{ port: number; server: Server }> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, LOOPBACK, () => {
			const { port } = server.address() as { port: number };
			resolve({ port, server });
		});
	});

live("file links of the built server over stdio", () => {
	const run = Date.now();
	let seeded: Seeded;
	let server: StdioServer;
	let call: ToolCaller;
	let pdfBytes: Uint8Array<ArrayBuffer>;

	beforeAll(async () => {
		seeded = await seedAccount("att-stdio", run);
		pdfBytes = fixture("sample.pdf");
		server = await startStdioServer(seeded.account);
		call = toolCaller(server);
	});

	afterAll(async () => {
		await server?.stop();
		await destroyCreatedAccounts();
	});

	test("download_attachment answers with a loopback URL that a plain fetch turns into the exact bytes", async () => {
		const url = await pdfDownloadUrl(call, seeded.withAttachmentsId);
		const { hostname, origin, protocol } = new URL(url);
		expect(protocol).toBe("http:");
		expect(hostname).toBe(LOOPBACK);
		expect(origin).toMatch(STDIO_ORIGIN_RE);

		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(res.headers.get("content-disposition")).toContain(
			'filename="invoice.pdf"'
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await bytesOf(res)).toEqual(pdfBytes);
		// A download link works until it expires, not once.
		expect(await bytesOf(await fetch(url))).toEqual(pdfBytes);
	});

	test("download_email answers with a loopback URL to the raw message", async () => {
		const answer = await call("download_email", { emailId: seeded.plainId });
		expect(answer.isError).toBe(false);
		expect(answer.text).toContain("No files here.eml (message/rfc822,");
		const url = answer.text.match(SERVED_DOWNLOAD_URL_RE)?.[1] as string;
		expect(new URL(url).hostname).toBe(LOOPBACK);
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("message/rfc822");
		expect(await res.text()).toBe(plainMime(seeded.account.address, run));
	});

	test("a tampered ticket is a plain 404", async () => {
		const url = await pdfDownloadUrl(call, seeded.withAttachmentsId);
		const res = await fetch(flipLast(url));
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("not found\n");
	});

	test("the loopback listener serves the ticket routes and nothing else", async () => {
		const { origin } = new URL(
			await pdfDownloadUrl(call, seeded.withAttachmentsId)
		);
		for (const path of ["/mcp", "/healthz", "/", "/attachments/"]) {
			expect((await fetch(`${origin}${path}`)).status).toBe(404);
		}
		const mcp = await fetch(`${origin}/mcp`, {
			body: "{}",
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(mcp.status).toBe(404);
	});

	test("a web page cannot use a link: a request naming another origin is refused", async () => {
		const url = await pdfDownloadUrl(call, seeded.withAttachmentsId);
		const res = await fetch(url, {
			headers: { origin: "https://attacker.example.com" },
		});
		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("%PDF");
	});

	test("upload_attachments answers with a loopback PUT URL that stores the file in the mailbox", async () => {
		const { origin } = new URL(
			await pdfDownloadUrl(call, seeded.withAttachmentsId)
		);
		await uploadPdf(call, seeded.session, origin);
	});

	test("the links are served on MCP_PORT when it is set, and on a free port when that one is taken", async () => {
		// A port that stays taken for the whole test, as by a first session.
		const taken = await listenOnFreePort();
		const second = await startStdioServer(seeded.account, {
			env: { MCP_PORT: String(taken.port) },
		});
		try {
			const url = await pdfDownloadUrl(
				toolCaller(second),
				seeded.withAttachmentsId
			);
			const { hostname, port } = new URL(url);
			expect(hostname).toBe(LOOPBACK);
			expect(port).not.toBe(String(taken.port));
			expect(await bytesOf(await fetch(url))).toEqual(pdfBytes);
			expect(second.stderr()).toContain("using a free port instead");
		} finally {
			await second.stop();
			await new Promise((resolve) => taken.server.close(resolve));
		}

		// Now that it is free, a server asked for it gets it.
		const third = await startStdioServer(seeded.account, {
			env: { MCP_PORT: String(taken.port) },
		});
		try {
			const url = await pdfDownloadUrl(
				toolCaller(third),
				seeded.withAttachmentsId
			);
			expect(new URL(url).origin).toBe(`http://${LOOPBACK}:${taken.port}`);
			expect(await bytesOf(await fetch(url))).toEqual(pdfBytes);
		} finally {
			await third.stop();
		}
	});

	test("nothing listens until a link is handed out, and the listener does not keep the server running once its client is gone", async () => {
		const raw = await startRawStdioServer(seeded.account);
		let code: number | null;
		try {
			const mint = async (): Promise<string> => {
				const { result } = await raw.request("tools/call", {
					arguments: { files: [{ filename: "scan.pdf" }] },
					name: "upload_attachments",
				});
				return JSON.stringify(result).match(UPLOAD_URL_RE)?.[1] as string;
			};
			if (canListListeningTcpPorts) {
				expect(listeningTcpSockets(raw.pid)).toEqual([]);
			}
			const url = new URL(await mint());
			expect(url.hostname).toBe(LOOPBACK);
			if (canListListeningTcpPorts) {
				expect(listeningTcpSockets(raw.pid)).toEqual([
					{ address: LOOPBACK, port: Number(url.port) },
				]);
			}
			// Bound and answering.
			expect((await fetch(`${url.origin}/attachments/x`)).status).toBe(404);
			// No signal is sent: the process has to end by itself when stdin
			// closes, although its link listener is still bound.
			code = await raw.end();
			expect(raw.stderr()).toBe("");
		} catch (error) {
			await raw.stop();
			throw error;
		}
		expect(code).toBe(0);
	});

	test("the loopback listener goes when the server does", async () => {
		const own = await startStdioServer(seeded.account);
		const url = await pdfDownloadUrl(toolCaller(own), seeded.withAttachmentsId);
		expect((await fetch(url)).status).toBe(200);
		await own.stop();
		await pollUntil(
			() => refusesConnections(url),
			(refused) => refused,
			{
				timeoutMs: STOPPED_BUDGET_MS,
				waitingFor: "the link listener to stop with its server",
			}
		);
	});
});

live("file links of the built server over HTTP", () => {
	const run = Date.now();
	let seeded: Seeded;
	let server: HttpServer;
	let call: ToolCaller;
	let pdfBytes: Uint8Array<ArrayBuffer>;

	beforeAll(async () => {
		seeded = await seedAccount("att-http", run);
		pdfBytes = fixture("sample.pdf");
		server = await startHttpServer(seeded.account);
		call = toolCaller(server);
	});

	afterAll(async () => {
		await server?.stop();
		await destroyCreatedAccounts();
	});

	test("the download URL lives under the listener's address and works without the bearer token, while /mcp still requires it", async () => {
		const url = await pdfDownloadUrl(call, seeded.withAttachmentsId);
		expect(url.startsWith(`${server.baseUrl}/attachments/`)).toBe(true);

		// No Authorization header: the link is the credential.
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(res.headers.get("content-disposition")).toContain(
			'filename="invoice.pdf"'
		);
		expect(await bytesOf(res)).toEqual(pdfBytes);

		const mcp = await fetch(server.mcpUrl, {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			method: "POST",
		});
		expect(mcp.status).toBe(401);
		expect(await mcp.text()).toBe('{"error":"unauthorized"}\n');
	});

	test("a tampered ticket is a plain 404, with or without the bearer token", async () => {
		const tampered = flipLast(
			await pdfDownloadUrl(call, seeded.withAttachmentsId)
		);
		expect((await fetch(tampered)).status).toBe(404);
		const withToken = await fetch(tampered, {
			headers: { authorization: `Bearer ${server.token}` },
		});
		expect(withToken.status).toBe(404);
	});

	test("a web page cannot use a link: a request naming another origin is refused", async () => {
		const url = await pdfDownloadUrl(call, seeded.withAttachmentsId);
		const res = await fetch(url, {
			headers: { origin: "https://attacker.example.com" },
		});
		expect(res.status).toBe(403);
	});

	test("upload_attachments answers with a PUT URL that stores the file in the mailbox, without the bearer token", async () => {
		await uploadPdf(call, seeded.session, server.baseUrl);
	});

	test("links are minted under MCP_PUBLIC_URL when it is set", async () => {
		const behindProxy = await startHttpServer(seeded.account, {
			env: { MCP_PUBLIC_URL: `${PUBLIC}/` },
		});
		try {
			const detail = await toolCaller(behindProxy)("get_email", {
				id: seeded.withAttachmentsId,
			});
			const download = await toolCaller(behindProxy)("download_attachment", {
				blobId: detail.text.match(PDF_LINE_RE)?.[1],
				emailId: seeded.withAttachmentsId,
			});
			const url = download.text.match(DOWNLOAD_URL_RE)?.[1] as string;
			expect(url.startsWith(`${PUBLIC}/attachments/`)).toBe(true);
			// What the proxy would pass on: same path, the public host.
			const res = await fetch(
				`${behindProxy.baseUrl}${new URL(url).pathname}`,
				{ headers: { host: PUBLIC_HOST } }
			);
			expect(res.status).toBe(200);
			expect(await bytesOf(res)).toEqual(pdfBytes);
		} finally {
			await behindProxy.stop();
		}
	});
});
