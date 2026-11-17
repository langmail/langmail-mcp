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
	renderSource: "html" | "text";
}

// Complete srcdoc document around the sanitized body. Forces a light canvas:
// with no declaration of its own, a nested srcdoc document inherits the
// embedder's color-scheme, and on a dark host that meant a black canvas with
// white UA text — email HTML is authored against a white page, the way every
// mail client renders it.
export const emailDocument = (body: string): string =>
	`<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light">` +
	`<style>body{margin:12px;background:#fff;color:#000}</style></head><body>${body}</body></html>`;
