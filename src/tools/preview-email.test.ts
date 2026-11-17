import { describe, expect, test, vi } from "vitest";
import {
	EMAIL_VIEWER_RESOURCE_URI,
	PREVIEW_META_KEY,
} from "../email-render/meta.ts";
import type { EmailDetailRecord } from "../jmap/index.ts";
import {
	type PreviewEmailDeps,
	previewEmail,
	registerPreviewEmail,
} from "./preview-email.ts";

const PUBLIC = "https://mcp.example.org";
const IMG_TAG_RE = /<img\b/gu;

const ticketEmail: EmailDetailRecord = {
	attachments: [
		{
			blobId: "Gqr",
			cid: "qr@mailer.example.com",
			disposition: "inline",
			name: "qr.png",
			partId: "3",
			size: 4200,
			type: "image/png",
		},
	],
	from: [{ email: "box-office@cinema.example.com", name: "Picture Palace" }],
	htmlBody: [{ blobId: "Ghtml", partId: "2", size: 9000, type: "text/html" }],
	id: "e1",
	keywords: { $seen: true, "$type:ticket": true },
	receivedAt: "2026-07-30T18:02:11Z",
	subject: "Your tickets for tonight",
	to: [{ email: "user@example.com" }],
};

const HTML =
	"<script>evil()</script>" +
	'<table><tr><td><img src="cid:qr@mailer.example.com" alt="QR"></td></tr></table>' +
	'<img src="https://cdn.cinema.example.com/banner.png">';

const makeDeps = (
	email: EmailDetailRecord | undefined,
	html: string
): PreviewEmailDeps => ({
	downloadHtmlPart: vi.fn(() =>
		Promise.resolve(new TextEncoder().encode(html))
	),
	emailGetDetail: vi.fn(() => Promise.resolve(email ? [email] : [])),
	mintAttachmentTicket: vi.fn(() => "att-tok"),
	mintImageToken: vi.fn(() => "img-tok"),
	publicUrl: vi.fn(() => Promise.resolve(PUBLIC)),
	resolveAccountId: vi.fn(() => Promise.resolve("acct")),
});

describe("previewEmail", () => {
	test("returns model metadata in structuredContent and sanitized HTML in _meta", async () => {
		const deps = makeDeps(ticketEmail, HTML);
		const out = await previewEmail(deps, { args: { id: "e1" }, token: "tok" });

		expect(out.isError).toBeUndefined();
		expect(out.structuredContent).toEqual({
			// The QR is an inline cid part already rendered in the preview, not a
			// document — same exclusion format.ts applies to attachment listings.
			attachmentCount: 0,
			date: "2026-07-30T18:02:11Z",
			from: "Picture Palace <box-office@cinema.example.com>",
			renderSource: "html",
			subject: "Your tickets for tonight",
			tags: ["ticket"],
		});

		const meta = out._meta as Record<string, { html: string }>;
		const html = meta[PREVIEW_META_KEY]?.html ?? "";
		// Model-facing text must not carry the body; the HTML rides in _meta only.
		expect(out.content[0]?.text ?? "").not.toContain("<table");
		expect(html).not.toContain("script");
		expect(html).toContain(`src="${PUBLIC}/attachments/att-tok"`);
		expect(html).toContain(`src="${PUBLIC}/image-proxy/img-tok"`);
		expect(html).not.toContain("cdn.cinema.example.com");
	});

	test("without an image-token minter, remote images are dropped and nothing is minted for them", async () => {
		const { mintImageToken: _off, ...deps } = makeDeps(ticketEmail, HTML);
		const out = await previewEmail(deps, { args: { id: "e1" }, token: "tok" });

		const meta = out._meta as Record<string, { html: string }>;
		const html = meta[PREVIEW_META_KEY]?.html ?? "";
		// The inline image still renders, from the message itself.
		expect(html).toContain(`src="${PUBLIC}/attachments/att-tok"`);
		// The remote one is gone: no proxy link, and no trace of the sender's
		// host for a client to load from.
		expect(html).not.toContain("image-proxy");
		expect(html).not.toContain("cdn.cinema.example.com");
		expect(html.match(IMG_TAG_RE)).toHaveLength(1);
		// The agent is told, so it can explain a preview with gaps.
		expect(out.content[0]?.text).toContain(
			"1 image(s) the email loads from the sender's servers are left out of the preview: this server fetches such images only with LANGMAIL_MCP_ALLOW_REMOTE_IMAGES on; it is off."
		);
		expect(out.structuredContent).toMatchObject({ renderSource: "html" });
	});

	test("says nothing about remote images when they are on, or when the email has none", async () => {
		const on = await previewEmail(makeDeps(ticketEmail, HTML), {
			args: { id: "e1" },
			token: "tok",
		});
		expect(on.content[0]?.text).not.toContain("LANGMAIL_MCP");
		const { mintImageToken: _off, ...deps } = makeDeps(
			ticketEmail,
			'<p>Hello</p><img src="cid:qr@mailer.example.com">'
		);
		const none = await previewEmail(deps, { args: { id: "e1" }, token: "tok" });
		expect(none.content[0]?.text).not.toContain("LANGMAIL_MCP");
	});

	test("asks for the public URL only when there is an HTML part to rewrite", async () => {
		const text: EmailDetailRecord = {
			...ticketEmail,
			attachments: [],
			bodyValues: { "1": { value: "plain" } },
			htmlBody: [],
			textBody: [{ partId: "1", type: "text/plain" }],
		};
		const textDeps = makeDeps(text, "");
		await previewEmail(textDeps, { args: { id: "e1" }, token: "tok" });
		// Over stdio this call starts the link listener: a text preview has no
		// link in it and must not open a port.
		expect(textDeps.publicUrl).not.toHaveBeenCalled();

		const htmlDeps = makeDeps(ticketEmail, HTML);
		await previewEmail(htmlDeps, { args: { id: "e1" }, token: "tok" });
		expect(htmlDeps.publicUrl).toHaveBeenCalledTimes(1);
	});

	test("mints the cid ticket with the part identity from the message", async () => {
		const deps = makeDeps(ticketEmail, HTML);
		await previewEmail(deps, { args: { id: "e1" }, token: "Bearer tok" });
		expect(deps.mintAttachmentTicket).toHaveBeenCalledWith({
			accountId: "acct",
			authorization: "Bearer tok",
			blobId: "Gqr",
			name: "qr.png",
			type: "image/png",
		});
	});

	test("falls back to an escaped text rendering when the message has no HTML part", async () => {
		const email: EmailDetailRecord = {
			...ticketEmail,
			attachments: [
				{
					blobId: "Gpdf",
					disposition: "attachment",
					name: "invoice.pdf",
					partId: "4",
					size: 8000,
					type: "application/pdf",
				},
			],
			bodyValues: { "1": { value: "Seats: A1 & A2 <balcony>" } },
			htmlBody: [],
			textBody: [{ partId: "1", type: "text/plain" }],
		};
		const deps = makeDeps(email, "");
		const out = await previewEmail(deps, { args: { id: "e1" }, token: "tok" });
		const structured = out.structuredContent as {
			attachmentCount: number;
			renderSource: string;
		};
		expect(structured.renderSource).toBe("text");
		// A genuine (non-inline) document still counts.
		expect(structured.attachmentCount).toBe(1);
		const meta = out._meta as Record<string, { html: string }>;
		expect(meta[PREVIEW_META_KEY]?.html).toContain(
			"Seats: A1 &amp; A2 &lt;balcony&gt;"
		);
		expect(deps.downloadHtmlPart).not.toHaveBeenCalled();
	});

	test("errors when the email does not exist", async () => {
		const deps = makeDeps(undefined, "");
		const out = await previewEmail(deps, {
			args: { id: "missing" },
			token: "tok",
		});
		expect(out.isError).toBe(true);
	});
});

describe("registerPreviewEmail", () => {
	test("registers with the viewer template linked via _meta.ui and an output schema", () => {
		const registerTool = vi.fn(() => ({}));
		const server = { registerTool } as unknown as Parameters<
			typeof registerPreviewEmail
		>[0];
		registerPreviewEmail(server, makeDeps(ticketEmail, HTML), () => "tok");

		expect(registerTool).toHaveBeenCalledTimes(1);
		const [name, config] = registerTool.mock.calls[0] as unknown as [
			string,
			Record<string, unknown>,
		];
		expect(name).toBe("preview_email");
		const meta = config._meta as { ui?: { resourceUri?: string } };
		expect(meta.ui?.resourceUri).toBe(EMAIL_VIEWER_RESOURCE_URI);
		expect(config.outputSchema).toBeDefined();
		expect(config.annotations).toMatchObject({ readOnlyHint: true });
		expect(String(config.description)).toContain("get_email");
	});
});
