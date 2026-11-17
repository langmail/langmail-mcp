import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildViewerHtml } from "../../scripts/viewer-bundle.ts";
import {
	createViewerHtmlLoader,
	registerEmailViewerResource,
} from "./viewer-resource.ts";

const PUBLIC = "https://mcp.example.org";

const NOT_BUILT_FAILURE =
	"the email viewer is not built: dist/email-render/email-viewer.html cannot be read. Run `npm run build`.";

type RegisterCall = [
	string,
	string,
	{
		_meta?: { ui?: { csp?: { resourceDomains?: string[] } } };
		mimeType?: string;
	},
	(uri: URL) => Promise<{
		contents: {
			_meta?: { ui?: { csp?: { resourceDomains?: string[] } } };
			mimeType?: string;
			text?: string;
			uri: string;
		}[];
	}>,
];

// The suite builds the viewer itself, into a directory of its own: it must
// pass on a checkout that has never run `npm run build`.
let dir: string;
let builtFile: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "email-viewer-resource-"));
	builtFile = join(dir, "email-viewer.html");
	await writeFile(builtFile, await buildViewerHtml());
});

afterAll(async () => {
	if (dir) {
		await rm(dir, { force: true, recursive: true });
	}
});

describe("emailViewerHtml", () => {
	test("bundles the view into one self-contained HTML document", async () => {
		const html = await buildViewerHtml();
		expect(html.startsWith("<!doctype html>")).toBe(true);
		// The App SDK handshake code must be inlined — no external scripts.
		expect(html).toContain('<script type="module">');
		expect(html).not.toContain("<script src=");
		expect(html).toContain("me.langmail/email-preview");
		const open = '<script type="module">';
		const js = html.slice(
			html.indexOf(open) + open.length,
			html.lastIndexOf("</script>")
		);
		// A "</script>" inside a JS string literal must not terminate the tag:
		// the only closer allowed is the shell's own, so the inlined JS between
		// the opening tag and the final closer must contain none.
		expect(js).not.toContain("</script>");
		// A bundler's iife format once referenced its CommonJS-interop helper
		// without ever defining it (the SDK chain contains a bundled `require`
		// shim), which crashed the view in a host with `__require is not
		// defined`. The esm build keeps the dependency's own guarded shim
		// instead. Tripwire only: if a future bundle legitimately *defines* the
		// helper, relax this to check reference-without-definition.
		expect(js).not.toContain("__require");
		// Nothing is left for the host's sandbox to resolve.
		expect(js).not.toMatch(IMPORT_FROM_RE);
	});

	test("is memoized", async () => {
		const load = createViewerHtmlLoader(builtFile);
		// Compared unawaited: two reads are byte-identical, so comparing the
		// strings passes even with the memo deleted. The promise identity is
		// what the memo actually guarantees.
		const first = load();
		expect(load()).toBe(first);
		expect(await first).toBe(await buildViewerHtml());
	});
});

// A bare-specifier or relative import that survived bundling.
const IMPORT_FROM_RE = /\bfrom\s*["'][@./\w]/u;

const registered = (
	publicUrl: Parameters<typeof registerEmailViewerResource>[1],
	loadHtml = createViewerHtmlLoader(builtFile)
): RegisterCall => {
	const registerResource = vi.fn(() => ({}));
	const server = { registerResource } as unknown as Parameters<
		typeof registerEmailViewerResource
	>[0];
	registerEmailViewerResource(server, publicUrl, loadHtml);
	expect(registerResource).toHaveBeenCalledTimes(1);
	return registerResource.mock.calls[0] as unknown as RegisterCall;
};

describe("registerEmailViewerResource", () => {
	test("registers ui://langmail/email-viewer with the MCP Apps mime type and a CSP scoped to our origin", async () => {
		const call = registered(`${PUBLIC}/`);

		expect(call[1]).toBe("ui://langmail/email-viewer");
		expect(call[2].mimeType).toBe("text/html;profile=mcp-app");
		// Images (cid capability URLs + proxied remote images) load from our
		// origin only — trailing slash normalized away.
		expect(call[2]._meta?.ui?.csp?.resourceDomains).toEqual([PUBLIC]);

		const read = await call[3](new URL("ui://langmail/email-viewer"));
		expect(read.contents[0]?.uri).toBe("ui://langmail/email-viewer");
		expect(read.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
		expect(read.contents[0]?.text).toContain('<script type="module">');
		expect(read.contents[0]?._meta?.ui?.csp?.resourceDomains).toEqual([PUBLIC]);
	});

	test("asks for an address that is not known yet only when the template is read", async () => {
		const publicUrl = vi.fn(() => Promise.resolve("http://127.0.0.1:49152"));
		const call = registered(publicUrl);

		// The listing is static: no origin in it, and nothing was started to
		// find one out.
		expect(call[2]._meta?.ui).toEqual({ prefersBorder: true });
		expect(publicUrl).not.toHaveBeenCalled();

		const read = await call[3](new URL("ui://langmail/email-viewer"));
		expect(publicUrl).toHaveBeenCalledTimes(1);
		expect(read.contents[0]?._meta?.ui).toEqual({
			csp: { resourceDomains: ["http://127.0.0.1:49152"] },
			prefersBorder: true,
		});
		expect(read.contents[0]?.text).toContain('<script type="module">');
	});

	test("declares no origin but the server's own, whatever the email contains", async () => {
		const call = registered("https://mcp.example.org/base/path");
		const read = await call[3](new URL("ui://langmail/email-viewer"));
		const ui = read.contents[0]?._meta?.ui as Record<string, unknown>;
		// No connectDomains, frameDomains or baseUriDomains: the view fetches
		// nothing, and images load from this server alone.
		expect(ui.csp).toEqual({ resourceDomains: ["https://mcp.example.org"] });
	});
});

describe("when the bundle fails", () => {
	test("rejects with every bundler log message joined", async () => {
		const broken = join(dir, "broken-view.ts");
		await writeFile(
			broken,
			'import "./missing-one.ts";\nimport "./missing-two.ts";\n'
		);
		const failure = await buildViewerHtml(broken).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(Error);
		const { message } = failure as Error;
		expect(message.startsWith("email-viewer bundle failed: ")).toBe(true);
		expect(message).toContain('Could not resolve "./missing-one.ts"');
		expect(message).toContain('; Could not resolve "./missing-two.ts"');
	});

	test("rejects when the built document is missing", async () => {
		const load = createViewerHtmlLoader(join(dir, "never-built.html"));
		await expect(load()).rejects.toThrow(NOT_BUILT_FAILURE);
	});

	test("surfaces the failure through the registered resource read", async () => {
		const call = registered(
			PUBLIC,
			createViewerHtmlLoader(join(dir, "never-built.html"))
		);
		await expect(
			call[3](new URL("ui://langmail/email-viewer"))
		).rejects.toThrow(NOT_BUILT_FAILURE);
	});

	test("does not open the link listener for a template it cannot serve", async () => {
		const publicUrl = vi.fn(() => Promise.resolve("http://127.0.0.1:49152"));
		const call = registered(
			publicUrl,
			createViewerHtmlLoader(join(dir, "never-built.html"))
		);
		await expect(
			call[3](new URL("ui://langmail/email-viewer"))
		).rejects.toThrow(NOT_BUILT_FAILURE);
		expect(publicUrl).not.toHaveBeenCalled();
	});

	test("does not poison the memo — the next read reads again", async () => {
		const late = join(dir, "built-later.html");
		const load = createViewerHtmlLoader(late);
		await expect(load()).rejects.toThrow(NOT_BUILT_FAILURE);

		// Had the rejected promise stayed in the memo, this read would reject
		// too.
		await writeFile(late, "<!doctype html><!-- rebuilt -->");
		expect(await load()).toContain("<!-- rebuilt -->");
	});
});
