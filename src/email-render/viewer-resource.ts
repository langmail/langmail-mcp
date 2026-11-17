// The ui://langmail/email-viewer template: a single self-contained HTML
// document, pre-declared as an MCP resource so hosts can prefetch, cache,
// and security-review it before any tool runs (SEP-1865). Per-email data
// never appears here — it arrives through the tool result at call time.
//
// The view's TypeScript (viewer/email-viewer.ts + the ext-apps App SDK) is
// bundled into that document when the package is built
// (scripts/build-viewer.ts writes dist/email-render/email-viewer.html). The
// server only reads the file, once, and needs no bundler at run time.

import { readFile } from "node:fs/promises";
import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps";
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

import { EMAIL_VIEWER_RESOURCE_URI } from "./meta.ts";

// The built document. The same relative path leads to it from this file in
// `src/email-render/` (a server run from source after a build) and from its
// compiled copy in `dist/email-render/` (the package).
const VIEWER_FILE = new URL(
	"../../dist/email-render/email-viewer.html",
	import.meta.url
);

// Minimal shell the bundled view script fills in. Theme-neutral colors that
// hold up on light and dark hosts; the email itself renders on white inside
// the nested iframe, matching how mail clients present HTML mail.
const shell = (script: string): string =>
	`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  #header { padding: 12px 16px 10px; border-bottom: 1px solid rgba(128,128,128,.35); }
  #subject { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  #from, #date { font-size: 12.5px; opacity: .75; }
  #frame { display: block; width: 100%; border: 0; background: #fff; }
</style>
</head>
<body>
<div id="header"><div id="subject"></div><div id="from"></div><div id="date"></div></div>
<iframe id="frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Email"></iframe>
<script type="module">${script}</script>
</body>
</html>
`;

/**
 * The viewer document around its bundled script. Used by the build; the
 * server reads the result from disk.
 */
export const viewerDocument = (script: string): string =>
	// "</script>" inside a JS string literal would terminate the inline tag.
	shell(script.replaceAll("</script>", "<\\/script>"));

export type LoadViewerHtml = () => Promise<string>;

/** A reader for the built viewer document at `file` that reads it once. */
export const createViewerHtmlLoader = (
	file: URL | string = VIEWER_FILE
): LoadViewerHtml => {
	// Memoize the promise, not the string, so concurrent first readers share
	// one read instead of racing their own.
	let cached: Promise<string> | null = null;
	return () => {
		cached ??= readFile(file, "utf8").catch((err: unknown) => {
			// A failed read must not poison every later one.
			cached = null;
			throw new Error(
				"the email viewer is not built: dist/email-render/email-viewer.html cannot be read. Run `npm run build`.",
				{ cause: err }
			);
		});
		return cached;
	};
};

export const emailViewerHtml: LoadViewerHtml = createViewerHtmlLoader();

/**
 * Registers the viewer template.
 *
 * `publicUrl` is the address the previewed email's images are served under
 * (attachment tickets for cid images, the image proxy for remote ones): the
 * only origin the view may load from. Pass a string when it is known now, as
 * over HTTP; the listing then carries the CSP too. Pass a function when
 * finding it out has a cost, as over stdio, where it starts the loopback
 * listener: it is then called only when a host reads the template, and the
 * listing stays static. Hosts take the CSP from the content they read; the
 * listing is a fallback.
 */
export const registerEmailViewerResource = (
	server: McpServer,
	publicUrl: string | (() => Promise<string>),
	loadHtml: LoadViewerHtml = emailViewerHtml
): void => {
	// Annotated because ui is built in one place to serve both sites below:
	// excess-property checking only reaches fresh literals, so without the
	// SDK's own shape a misspelled key would travel straight to the host.
	const uiFor = (url: string): McpUiResourceMeta => ({
		// Images — cid capability URLs and proxied remote images — load from
		// this server only. No connectDomains: the view makes no fetches.
		// CSP wants origins; the public URL may carry a trailing slash or path.
		csp: { resourceDomains: [new URL(url).origin] },
		prefersBorder: true,
	});
	const listed: McpUiResourceMeta =
		typeof publicUrl === "string" ? uiFor(publicUrl) : { prefersBorder: true };
	registerAppResource(
		server,
		"email-viewer",
		EMAIL_VIEWER_RESOURCE_URI,
		{
			_meta: { ui: listed },
			description:
				"Inline full-fidelity rendering of one email, fed by the preview_email tool.",
			mimeType: RESOURCE_MIME_TYPE,
		},
		async () => {
			const text = await loadHtml();
			const ui =
				typeof publicUrl === "string" ? listed : uiFor(await publicUrl());
			return {
				contents: [
					{
						_meta: { ui },
						mimeType: RESOURCE_MIME_TYPE,
						text,
						uri: EMAIL_VIEWER_RESOURCE_URI,
					},
				],
			};
		}
	);
};
