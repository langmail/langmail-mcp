// Executes the bundled viewer script in a browser-ish global scope instead of
// only string-inspecting it. This is the tier that catches "the bundle does
// not run at all": a bundler's iife format once emitted a reference to its
// CommonJS-interop helper `__require` without defining it, which threw a
// ReferenceError inside a host's sandbox before the view could connect — a
// class of failure invisible to the string tripwires.
//
// Scope: eval-time execution only. The postMessage handshake has no host on
// the other side here, so `app.connect()` never resolves — the view's own
// .catch keeps that from failing the import. "Handshakes and renders" needs a
// real browser plus a fake host, not this suite.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildViewerHtml } from "../../scripts/viewer-bundle.ts";

const SCRIPT_OPEN = '<script type="module">';

// Only viewer/ is written against the DOM; happy-dom registers the globals
// at runtime, so type just what we touch.
const dom = globalThis as unknown as {
	document: { body: { innerHTML: string } };
};

// The shell markup between <body> and the script tag, so the ids the view
// touches (#subject, #frame, …) exist when the module evaluates.
const shellMarkup = (html: string): string =>
	html.slice(
		html.indexOf("<body>") + "<body>".length,
		html.indexOf(SCRIPT_OPEN)
	);

// The inlined module source, with the serving-side "</script>" escape undone.
const scriptSource = (html: string): string =>
	html
		.slice(
			html.indexOf(SCRIPT_OPEN) + SCRIPT_OPEN.length,
			html.lastIndexOf("</script>")
		)
		.replaceAll("<\\/script>", "</script>");

describe("email-viewer bundle execution", () => {
	let dir: string;

	beforeAll(() => {
		GlobalRegistrator.register();
	});

	afterAll(async () => {
		// Unregister first: a failure before `dir` is assigned must not leave the
		// DOM globals bleeding into every later test file in the process.
		await GlobalRegistrator.unregister();
		if (dir) {
			await rm(dir, { force: true, recursive: true });
		}
	});

	test("the inlined module evaluates in a DOM without throwing", async () => {
		const html = await buildViewerHtml();
		// Guard the slice: if the template's tag shape ever changes, fail loudly
		// instead of importing an empty fragment (which would happily resolve).
		expect(html.indexOf(SCRIPT_OPEN)).toBeGreaterThan(-1);
		expect(html.lastIndexOf("</script>")).toBeGreaterThan(
			html.indexOf(SCRIPT_OPEN)
		);
		dom.document.body.innerHTML = shellMarkup(html);

		dir = await mkdtemp(join(tmpdir(), "email-viewer-"));
		const file = join(dir, "viewer.mjs");
		await writeFile(file, scriptSource(html));

		// A missing bundler helper (__require et al.), TDZ breakage, or any other
		// eval-time throw rejects this import.
		await expect(import(file)).resolves.toBeDefined();
	});
});
