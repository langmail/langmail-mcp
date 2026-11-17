import { describe, expect, test } from "vitest";

import { sanitizeEmailHtml } from "./sanitize.ts";

// Resolvers used across cases: cid parts map to a capability URL, remote
// images map to the proxy. Returning null means "no such part" / "refused".
const resolvers = {
	resolveCid: (cid: string) =>
		cid === "qr@example.org"
			? "https://mcp.example.org/attachments/tkt1"
			: null,
	resolveRemote: (url: string) =>
		url.startsWith("https://")
			? `https://mcp.example.org/image-proxy/tkt2?src=${encodeURIComponent(url)}`
			: null,
};

describe("sanitizeEmailHtml", () => {
	test("strips script tags and inline event handlers", () => {
		const out = sanitizeEmailHtml(
			'<div onclick="steal()">hi</div><script>fetch("https://evil.example/x")</script>',
			resolvers
		);
		expect(out).not.toContain("script");
		expect(out).not.toContain("onclick");
		expect(out).toContain("hi");
	});

	test("removes forms and inputs", () => {
		const out = sanitizeEmailHtml(
			'<form action="https://evil.example"><input name="pw"><button>go</button></form>',
			resolvers
		);
		expect(out).not.toContain("<form");
		expect(out).not.toContain("<input");
		expect(out).not.toContain("<button");
	});

	test("rewrites cid: images to the resolved capability URL", () => {
		const out = sanitizeEmailHtml(
			'<img src="cid:qr@example.org" alt="qr">',
			resolvers
		);
		expect(out).toContain('src="https://mcp.example.org/attachments/tkt1"');
		expect(out).toContain('alt="qr"');
	});

	test("rewrites remote https images to the proxy URL", () => {
		const out = sanitizeEmailHtml(
			'<img src="https://cdn.example.com/banner.png">',
			resolvers
		);
		expect(out).toContain(
			'src="https://mcp.example.org/image-proxy/tkt2?src=https%3A%2F%2Fcdn.example.com%2Fbanner.png"'
		);
		expect(out).not.toContain('cdn.example.com/banner.png"');
	});

	test("keeps raster data: URI images untouched", () => {
		const src = "data:image/png;base64,iVBORw0KGgo=";
		const out = sanitizeEmailHtml(`<img src="${src}">`, resolvers);
		expect(out).toContain(`src="${src}"`);
	});

	test("drops SVG data: URIs — the one image subtype that can carry script", () => {
		const out = sanitizeEmailHtml(
			'<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
			resolvers
		);
		expect(out).not.toContain("<img");
	});

	test("keeps resolver-minted http URLs (the dev-mode public URL is http)", () => {
		const httpResolvers = {
			resolveCid: () => "http://127.0.0.1:8080/attachments/tkt1",
			resolveRemote: () => null,
		};
		const out = sanitizeEmailHtml(
			'<img src="cid:qr@example.org">',
			httpResolvers
		);
		expect(out).toContain('src="http://127.0.0.1:8080/attachments/tkt1"');
	});

	test("drops images the resolvers refuse", () => {
		const out = sanitizeEmailHtml(
			'<p>x</p><img src="cid:unknown@example.org"><img src="http://plain.example.com/a.png">',
			resolvers
		);
		expect(out).not.toContain("<img");
		expect(out).toContain("<p>x</p>");
	});

	test("drops javascript: links but keeps https and mailto links", () => {
		const out = sanitizeEmailHtml(
			'<a href="javascript:alert(1)">bad</a><a href="https://tickets.example.org/t/1">View ticket</a><a href="mailto:box@example.org">write</a>',
			resolvers
		);
		expect(out).not.toContain("javascript:");
		expect(out).toContain('href="https://tickets.example.org/t/1"');
		expect(out).toContain('href="mailto:box@example.org"');
	});

	test("keeps table layout, inline styles, and style blocks", () => {
		const out = sanitizeEmailHtml(
			"<style>.h{color:#123}</style>" +
				'<table width="600" cellpadding="0"><tr><td style="background-color:#fff" align="center">seat A1</td></tr></table>',
			resolvers
		);
		expect(out).toContain("<style>.h{color:#123}</style>");
		expect(out).toContain('<table width="600" cellpadding="0">');
		expect(out).toContain(
			'<td style="background-color:#fff" align="center">seat A1</td>'
		);
	});

	test("strips nested iframes and objects", () => {
		const out = sanitizeEmailHtml(
			'<iframe src="https://evil.example"></iframe><object data="x"></object><p>ok</p>',
			resolvers
		);
		expect(out).not.toContain("<iframe");
		expect(out).not.toContain("<object");
		expect(out).toContain("<p>ok</p>");
	});
});
