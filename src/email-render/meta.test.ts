import { describe, expect, test } from "vitest";

import { emailDocument, emailDocumentCsp } from "./meta.ts";

describe("emailDocument", () => {
	test("wraps the sanitized body in a light-scheme document", () => {
		const doc = emailDocument("<p>Seats G6, G5</p>");
		// Without an explicit scheme the nested srcdoc inherits the host's dark
		// color-scheme — black canvas, white UA text. Email is authored for white.
		expect(doc).toContain('<meta name="color-scheme" content="light">');
		expect(doc).toContain("body{margin:12px;background:#fff;color:#000}");
		expect(doc).toContain("<body><p>Seats G6, G5</p></body>");
	});

	test("carries its own CSP as the first thing after the charset", () => {
		const doc = emailDocument("<p>hi</p>", "http://127.0.0.1:8080");
		expect(doc).toContain(
			`<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http://127.0.0.1:8080; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`
		);
		// Nothing the policy governs may come before it.
		expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(
			doc.indexOf("<style>")
		);
		expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(
			doc.indexOf("<body>")
		);
	});
});

describe("emailDocumentCsp", () => {
	test("allows images from data: URIs and this server's origin, inline styles, and nothing else", () => {
		expect(emailDocumentCsp("https://mcp.example.com")).toBe(
			"default-src 'none'; img-src data: https://mcp.example.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
		);
	});

	test("allows only data: images when the preview has no image links", () => {
		expect(emailDocumentCsp()).toBe(
			"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
		);
	});

	test("reduces a URL to its origin", () => {
		expect(emailDocumentCsp("https://mcp.example.com/base/path?x=1")).toContain(
			"img-src data: https://mcp.example.com;"
		);
	});

	test.each([
		["not a URL", "nonsense"],
		["a directive smuggled in", "https://a.example; script-src *"],
		["another scheme", "javascript:alert(1)"],
		["a wildcard", "*"],
	])("ignores %s", (_name, value) => {
		expect(emailDocumentCsp(value)).toBe(emailDocumentCsp());
	});
});
