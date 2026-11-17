// preview_email tool — full-fidelity inline rendering of one message via the
// MCP Apps extension (SEP-1865). One result, two audiences on separate
// channels: the model gets token-cheap metadata in structuredContent, the
// user gets the sanitized HTML body rendered by the ui://langmail/email-viewer
// template. The raw body never enters model context — it rides in result
// _meta, which hosts forward to the view (ui/notifications/tool-result) but
// keep out of the conversation.
//
// The HTTP transport is stateless (one McpServer per request), so the server
// cannot see client capabilities at call time and never branches on Apps
// support, on either transport: the UI metadata is always attached, and hosts without the
// extension simply show the text/metadata. The result text says so, so the
// agent can set expectations honestly.

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TicketInput, TicketStore } from "../attachments/tickets.ts";
import {
	type ImageProxyStore,
	isProxyableImageUrl,
} from "../email-render/image-proxy.ts";
import {
	EMAIL_VIEWER_RESOURCE_URI,
	PREVIEW_META_KEY,
} from "../email-render/meta.ts";
import { sanitizeEmailHtml } from "../email-render/sanitize.ts";
import {
	authorizationHeader,
	blobDownload,
	type EmailDetailRecord,
	type EmailGetDetailParams,
	emailGetDetail,
	type JmapLive,
} from "../jmap/index.ts";
import { logger } from "../logger.ts";
import { READ_ONLY } from "./annotations.ts";
import { emailTags, formatAddressList, isInlinePart } from "./format.ts";
import { bodyText, MAX_BODY_VALUE_BYTES } from "./get-email.ts";
import { errorResult, type ToolResult } from "./result.ts";

// HTML parts above this size skip the download (a body this big is not a
// ticket or an invoice) and fall back to the text rendering.
const MAX_HTML_PART_BYTES = 2_000_000;

const previewEmailShape = {
	id: z
		.string()
		.min(1)
		.describe("The message id, as returned by search_emails or get_thread."),
};

export const previewEmailInput = z.object(previewEmailShape);

export type PreviewEmailArgs = z.infer<typeof previewEmailInput>;

const previewEmailOutputShape = {
	attachmentCount: z.number(),
	date: z.string(),
	from: z.string(),
	renderSource: z
		.enum(["html", "text"])
		.describe(
			"Whether the preview shows the HTML part or a plain-text fallback."
		),
	subject: z.string(),
	tags: z
		.array(z.string())
		.describe('The message tags ($type/$label), e.g. "ticket" or "receipt".'),
};

export interface HtmlPartParams {
	accountId: string;
	authorization: string;
	blobId: string;
}

export interface PreviewEmailDeps {
	downloadHtmlPart: (p: HtmlPartParams) => Promise<Uint8Array>;
	emailGetDetail: (p: EmailGetDetailParams) => Promise<EmailDetailRecord[]>;
	// The attachment tickets, reused for cid-inline images.
	mintAttachmentTicket: (input: TicketInput) => string;
	// Image-proxy token for a vetted remote image URL. Absent unless the user
	// has turned remote images on: the preview then drops them, and nothing
	// fetches them.
	mintImageToken?: (url: string) => string;
	// Base URL the image links live under. Asked for only when a message has
	// an HTML part to rewrite: over stdio that is what starts the listener the
	// links are served on.
	publicUrl: () => Promise<string>;
	resolveAccountId: (authorization: string) => Promise<string>;
}

export interface PreviewEmailContext {
	args: PreviewEmailArgs;
	token: string;
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
};
const escapeHtml = (text: string): string =>
	text.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);

// Plain-text fallback rendered as HTML so the viewer has one input shape.
const textAsHtml = (text: string): string =>
	`<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:14px/1.5 ui-sans-serif,system-ui,sans-serif">${escapeHtml(text)}</pre>`;

// The message's own HTML, if it has a usable text/html part: first such part,
// downloaded in full (no truncation cap — a cut-off tag soup renders worse
// than the text fallback). Bytes are decoded as UTF-8; that is the modern
// default and charset plumbing isn't worth the edge case.
const htmlOfEmail = async (
	deps: PreviewEmailDeps,
	p: Omit<HtmlPartParams, "blobId">,
	email: EmailDetailRecord
): Promise<string | null> => {
	const part = (email.htmlBody ?? []).find(
		(c) => c.type === "text/html" && c.blobId
	);
	// An unknown size counts as oversized — the guard must not be bypassable
	// by a missing property (same stance as get_email's raw-message cap).
	if (
		!part?.blobId ||
		(part.size ?? Number.POSITIVE_INFINITY) > MAX_HTML_PART_BYTES
	) {
		return null;
	}
	try {
		const raw = await deps.downloadHtmlPart({ ...p, blobId: part.blobId });
		const html = new TextDecoder().decode(raw).trim();
		return html || null;
	} catch (err) {
		logger.warn(
			{ detail: err instanceof Error ? err.name : "unknown" },
			"html part download failed, using text fallback"
		);
		return null;
	}
};

export const previewEmail = async (
	deps: PreviewEmailDeps,
	ctx: PreviewEmailContext
): Promise<ToolResult> => {
	const { token, args } = ctx;
	const authorization = authorizationHeader(token);
	const accountId = await deps.resolveAccountId(authorization);
	const [email] = await deps.emailGetDetail({
		accountId,
		apiUrl: "",
		authorization,
		ids: [args.id],
		maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
	});
	if (!email) {
		return errorResult(`Email not found: ${args.id}`);
	}

	const rawHtml = await htmlOfEmail(deps, { accountId, authorization }, email);
	const publicUrl = rawHtml ? await deps.publicUrl() : "";
	const { mintImageToken } = deps;
	// Remote images left out because the user has not turned them on.
	let remoteImagesOff = 0;
	const html = rawHtml
		? sanitizeEmailHtml(rawHtml, {
				resolveCid: (cid) => {
					const part = (email.attachments ?? []).find(
						(a) => a.cid === cid && a.blobId
					);
					if (!part?.blobId) {
						return null;
					}
					const ticket = deps.mintAttachmentTicket({
						accountId,
						authorization,
						blobId: part.blobId,
						name: part.name ?? "inline",
						type: part.type ?? "application/octet-stream",
					});
					return `${publicUrl}/attachments/${ticket}`;
				},
				resolveRemote: (url) => {
					if (!mintImageToken) {
						remoteImagesOff += 1;
						return null;
					}
					return isProxyableImageUrl(url)
						? `${publicUrl}/image-proxy/${mintImageToken(url)}`
						: null;
				},
			})
		: textAsHtml(bodyText(email) || "(no text body)");
	const renderSource = rawHtml ? "html" : "text";

	const structuredContent = {
		// Real documents only: an inline cid part (the QR, a logo) is already
		// rendered in the preview and must not read as a separate attachment.
		attachmentCount: (email.attachments ?? []).filter(
			(part) => !isInlinePart(part)
		).length,
		date: email.receivedAt ?? "",
		from: formatAddressList(email.from) || "(unknown sender)",
		renderSource,
		subject: email.subject ?? "(no subject)",
		tags: emailTags(email),
	};

	return {
		_meta: { [PREVIEW_META_KEY]: { html, renderSource } },
		content: [
			{
				text:
					`Preview of "${structuredContent.subject}" prepared (${renderSource} rendering). ` +
					"On clients with MCP Apps support the email renders inline in the conversation. " +
					"If no rendered email is visible to the user, this client does not support inline " +
					"rendering — say so, and use get_email to relay the content instead." +
					(remoteImagesOff > 0
						? ` ${remoteImagesOff} image(s) the email loads from the sender's servers are left out of the preview: this server fetches such images only with LANGMAIL_MCP_ALLOW_REMOTE_IMAGES on; it is off.`
						: ""),
				type: "text",
			},
		],
		structuredContent,
	};
};

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
	live: JmapLive,
	tickets: TicketStore,
	// Undefined unless the user has turned remote images on.
	images: ImageProxyStore | undefined,
	publicUrl: () => Promise<string>
): PreviewEmailDeps => ({
	downloadHtmlPart: async (p) => {
		const res = await blobDownload({
			accountId: p.accountId,
			authorization: p.authorization,
			blobId: p.blobId,
			downloadUrl: (await live.getSession(p.authorization)).downloadUrl,
			name: "body.html",
			type: "text/html",
		});
		return new Uint8Array(await res.arrayBuffer());
	},
	emailGetDetail: async (p) =>
		emailGetDetail({
			...p,
			apiUrl: (await live.getSession(p.authorization)).apiUrl,
		}),
	mintAttachmentTicket: tickets.mint,
	mintImageToken: images?.mint,
	publicUrl,
	resolveAccountId: live.resolveAccountId,
});

// --- MCP registration ----------------------------------------------------

export const registerPreviewEmail = (
	server: McpServer,
	deps: PreviewEmailDeps,
	getToken: () => string
): void => {
	registerAppTool(
		server,
		"preview_email",
		{
			_meta: { ui: { resourceUri: EMAIL_VIEWER_RESOURCE_URI } },
			annotations: READ_ONLY,
			description:
				"Show one email to the user as a rendered document, inline in the " +
				"conversation. Use it when the user asks to see, show, or display an " +
				"email or a document contained in one — tickets, boarding passes, " +
				"invoices, receipts — where the visual rendering (QR codes, barcodes, " +
				"table layouts) is the point. Use get_email instead when you need the " +
				"content for reasoning, summarization, or extraction and the user does " +
				"not need the pixels. The result gives the model only compact metadata; " +
				"the rendered body is shown to the user by the client and is not in " +
				"your context — do not claim to have read it from this call.",
			inputSchema: z.object(previewEmailShape),
			outputSchema: z.object(previewEmailOutputShape),
			title: "Preview email",
		},
		(args) => {
			const parsed = previewEmailInput.parse(args);
			return previewEmail(deps, { args: parsed, token: getToken() });
		}
	);
};
