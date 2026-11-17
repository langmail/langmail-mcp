// The email-viewer view — runs inside the host's sandboxed iframe, not on
// the server. Bundled to a single inline <script> by viewer-resource.ts.
//
// Data flow: the host forwards preview_email's full tool result via
// ui/notifications/tool-result; this view reads the sanitized document from
// result _meta and the header fields from structuredContent, then renders
// the document into a nested script-less iframe. The nested iframe keeps
// `allow-same-origin` (and nothing else) so this shell can measure the
// document's height; with scripts disabled that grant is inert.

import { App } from "@modelcontextprotocol/ext-apps";

import {
	emailDocument,
	PREVIEW_META_KEY,
	type PreviewPayload,
} from "../meta.ts";

interface HeaderFields {
	date?: string;
	from?: string;
	subject?: string;
}

const FORWARDABLE_HREF_RE = /^(https?|mailto|tel):/i;

const el = (id: string): HTMLElement => {
	const node = document.getElementById(id);
	if (!node) {
		throw new Error(`viewer shell is missing #${id}`);
	}
	return node;
};

const renderHeader = (fields: HeaderFields): void => {
	el("subject").textContent = fields.subject ?? "(no subject)";
	el("from").textContent = fields.from ?? "";
	el("date").textContent = fields.date
		? new Date(fields.date).toLocaleString()
		: "";
};

// The email document is script-less, so link clicks can't be handled inside
// it; the sandbox also blocks its navigation. `allow-same-origin` lets this
// shell reach in, intercept anchor clicks, and hand the URL to the host via
// the MCP Apps ui/open-link request — the host opens it in a new tab.
const forwardLinkClicks = (doc: Document): void => {
	doc.addEventListener("click", (event) => {
		const anchor = (event.target as Element | null)?.closest(
			"a[href]"
		) as HTMLAnchorElement | null;
		if (!anchor) {
			return;
		}
		// Fragment links stay in-document navigation, which the sandbox permits.
		if (anchor.getAttribute("href")?.startsWith("#")) {
			return;
		}
		event.preventDefault();
		// Guard the raw attribute, not the resolved .href: the sanitizer's scheme
		// filter only sees hrefs that have a scheme, and a relative href would
		// resolve against the shell's own base URL — a sender-chosen path on the
		// host origin. Only explicit absolute schemes are forwarded.
		if (FORWARDABLE_HREF_RE.test(anchor.getAttribute("href") ?? "")) {
			app.openLink({ url: anchor.href }).catch(() => {
				// Host without openLinks support: nothing sensible to do in-view.
			});
		}
	});
};

const renderBody = (payload: PreviewPayload): void => {
	const frame = el("frame") as HTMLIFrameElement;
	// Property assignment, not addEventListener: a re-render replaces the
	// handler, so two tool results racing one load can't wire the click
	// forwarder twice (which would open every link in two tabs).
	frame.onload = () => {
		const doc = frame.contentDocument;
		if (!doc) {
			return;
		}
		forwardLinkClicks(doc);
		// Let the email breathe at its natural height; the App SDK's autoResize
		// reports the resulting shell size to the host.
		frame.style.height = `${Math.min(doc.documentElement.scrollHeight + 24, 4000)}px`;
	};
	frame.srcdoc = emailDocument(payload.html, payload.imageOrigin);
};

const app = new App(
	{ name: "langmail-email-viewer", version: "0.1.0" },
	{},
	{ autoResize: true }
);

app.addEventListener("toolresult", (result) => {
	const meta = (result._meta ?? {}) as Record<string, unknown>;
	const payload = meta[PREVIEW_META_KEY] as PreviewPayload | undefined;
	renderHeader((result.structuredContent ?? {}) as HeaderFields);
	if (payload?.html) {
		renderBody(payload);
	} else {
		el("subject").textContent = "No preview data received.";
	}
});

app.connect().catch(() => {
	el("subject").textContent = "Could not connect to the host.";
});
