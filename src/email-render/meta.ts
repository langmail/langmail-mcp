// Shared between the preview_email tool (server) and the email-viewer view
// (browser bundle) — keep this module dependency-free so the view bundle
// stays lean.

// The pre-declared MCP Apps template (SEP-1865) the preview_email tool
// binds to via _meta.ui.resourceUri.
export const EMAIL_VIEWER_RESOURCE_URI = "ui://langmail/email-viewer";

// Result-_meta key carrying the sanitized document from tool to view. _meta
// is forwarded to the iframe via ui/notifications/tool-result but is not
// model context — that separation is the point (the body can be huge).
export const PREVIEW_META_KEY = "me.langmail/email-preview";

export interface PreviewPayload {
	html: string;
	// The origin this server's image links live under (attachment links for
	// inline images, the image proxy when remote images are on). The only
	// origin the email document may load an image from; absent when the
	// preview has no such links.
	imageOrigin?: string;
	renderSource: "html" | "text";
}

// The origin as a CSP source, or nothing when it is not a plain http(s)
// origin. `URL.origin` cannot carry a space, a quote or a semicolon, so the
// value cannot add a directive of its own.
const cspImageSource = (imageOrigin: string | undefined): string => {
	if (!imageOrigin) {
		return "";
	}
	try {
		const url = new URL(imageOrigin);
		return url.protocol === "http:" || url.protocol === "https:"
			? ` ${url.origin}`
			: "";
	} catch {
		return "";
	}
};

// The Content-Security-Policy of the email document itself.
//
// The sender's CSS is kept for layout (`<style>`, `style=`), and CSS can name
// URLs: `url(...)`, `@import`, `@font-face`. The MCP Apps host is meant to
// stop those with the CSP the viewer template declares, but a host that does
// not enforce it would let the user's client fetch from the sender, which
// tells the sender the mail was opened. So the document carries its own
// policy, which the browser enforces whatever the host does:
// - nothing loads by default: no scripts, fonts, frames, media, connections;
// - images only from `data:` URIs and this server's own origin;
// - styles only inline, so `@import` of a remote sheet is refused.
export const emailDocumentCsp = (imageOrigin?: string): string =>
	`default-src 'none'; img-src data:${cspImageSource(imageOrigin)}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;

// Complete srcdoc document around the sanitized body. Forces a light canvas:
// with no declaration of its own, a nested srcdoc document inherits the
// embedder's color-scheme, and on a dark host that meant a black canvas with
// white UA text — email HTML is authored against a white page, the way every
// mail client renders it. The CSP comes first, before anything it governs.
export const emailDocument = (body: string, imageOrigin?: string): string =>
	`<!doctype html><html><head><meta charset="utf-8">` +
	`<meta http-equiv="Content-Security-Policy" content="${emailDocumentCsp(imageOrigin)}">` +
	`<meta name="color-scheme" content="light">` +
	`<style>body{margin:12px;background:#fff;color:#000}</style></head><body>${body}</body></html>`;
