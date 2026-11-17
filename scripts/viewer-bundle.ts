// Bundles the email viewer (src/email-render/viewer/email-viewer.ts and the
// MCP Apps SDK it imports) into the one self-contained HTML document the
// server hands to hosts as ui://langmail/email-viewer.
//
// This runs when the package is built, never in the server: esbuild is a
// development dependency.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { viewerDocument } from "../src/email-render/viewer-resource.ts";

const VIEW_ENTRYPOINT = fileURLToPath(
	new URL("../src/email-render/viewer/email-viewer.ts", import.meta.url)
);

/** The viewer document, with the view's script bundled and inlined. */
export const buildViewerHtml = async (
	entryPoint: string = VIEW_ENTRYPOINT
): Promise<string> => {
	// esm, inlined by the shell as <script type="module">. One file, no
	// imports left: the host's sandbox has nowhere to load a second one from.
	const result = await build({
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		legalComments: "none",
		logLevel: "silent",
		minify: true,
		platform: "browser",
		target: "es2022",
		write: false,
	}).catch((err: unknown) => {
		const errors = (err as { errors?: { text: string }[] } | null)?.errors;
		throw new Error(
			`email-viewer bundle failed: ${(errors ?? []).map((e) => e.text).join("; ")}`,
			{ cause: err }
		);
	});
	const [output] = result.outputFiles;
	if (!output) {
		throw new Error("email-viewer bundle failed: no output");
	}
	return viewerDocument(output.text);
};
