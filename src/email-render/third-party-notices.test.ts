// The viewer is one file with other people's code compiled into it; their
// notices have to go wherever it goes. These tests tie the notices to what
// the bundler actually put in, so a dependency change cannot leave them stale.

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";

import {
	type BundledPackage,
	NOTICES_FILE,
	noticeBanner,
	renderNotices,
} from "../../scripts/third-party.ts";
import { bundleViewer } from "../../scripts/viewer-bundle.ts";

const SCRIPT_OPEN = '<script type="module">';
// The licenses the bundle is known to be made of. A new one is a decision.
const KNOWN_LICENSE_RE = /^(MIT|Apache-2\.0)$/u;

describe("third-party notices for the bundled viewer", () => {
	let html: string;
	let packages: BundledPackage[];

	beforeAll(async () => {
		({ html, packages } = await bundleViewer());
	});

	test("THIRD_PARTY_NOTICES.md is what the bundle calls for (run `npm run notices` if not)", async () => {
		expect(await readFile(NOTICES_FILE, "utf8")).toBe(renderNotices(packages));
	});

	test("lists the packages esbuild bundled and the ones compiled into them", () => {
		const names = packages.map((pkg) => pkg.name);
		// Bundled from node_modules.
		for (const name of [
			"@modelcontextprotocol/client",
			"@modelcontextprotocol/core",
			"@modelcontextprotocol/ext-apps",
			"zod",
		]) {
			expect(names).toContain(name);
		}
		// Compiled into the MCP client's published files: invisible to the
		// metafile, found by the markers their bundler left.
		expect(
			packages.find((pkg) => pkg.name === "@cfworker/json-schema")
		).toEqual(
			expect.objectContaining({
				license: "MIT",
				vendoredIn: expect.stringContaining("@modelcontextprotocol/client@"),
			})
		);
		expect(names).toContain("content-type");
	});

	test("every package has a license id and its license text", () => {
		for (const pkg of packages) {
			expect(pkg.license, pkg.name).toMatch(KNOWN_LICENSE_RE);
			expect(pkg.licenseText.length, pkg.name).toBeGreaterThan(500);
		}
		const notices = renderNotices(packages);
		expect(notices).toContain("Apache License");
		expect(notices).toContain("Permission is hereby granted, free of charge");
	});

	test("the viewer itself opens with a banner naming every bundled package", () => {
		const script = html.slice(html.indexOf(SCRIPT_OPEN) + SCRIPT_OPEN.length);
		expect(script.startsWith(noticeBanner(packages))).toBe(true);
		for (const pkg of packages) {
			expect(script.slice(0, 2000)).toContain(
				` * ${pkg.name} ${pkg.version} (${pkg.license})`
			);
		}
		expect(script.slice(0, 2000)).toContain("THIRD_PARTY_NOTICES.md");
		// The banner is one comment: nothing in it ends it early.
		const banner = noticeBanner(packages);
		expect(banner.indexOf("*/")).toBe(banner.length - 2);
		expect(banner).not.toContain("</script>");
	});

	test("the license comments the bundled packages carry are kept", () => {
		expect(html).toContain("Bundled license information:");
	});

	test("the notices file is part of the published package", async () => {
		const manifest = JSON.parse(
			await readFile(new URL("../../package.json", import.meta.url), "utf8")
		) as { files: string[] };
		expect(manifest.files).toContain("THIRD_PARTY_NOTICES.md");
	});
});
