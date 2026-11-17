// Bundles the email viewer (src/email-render/viewer/email-viewer.ts and the
// MCP Apps SDK it imports) into the one self-contained HTML document the
// server hands to hosts as ui://langmail/email-viewer.
//
// This runs when the package is built, never in the server: esbuild is a
// development dependency.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { viewerDocument } from "../src/email-render/viewer-resource.ts";
import {
	type BundledPackage,
	bundledPackages,
	noticeBanner,
	REPOSITORY_ROOT,
} from "./third-party.ts";

const VIEW_ENTRYPOINT = fileURLToPath(
	new URL("../src/email-render/viewer/email-viewer.ts", import.meta.url)
);

export interface ViewerBundle {
	/** The viewer document, with the view's script bundled and inlined. */
	html: string;
	/** The third-party packages whose code is in that script. */
	packages: BundledPackage[];
}

/** Bundles the view and says whose code went into it. */
export const bundleViewer = async (
	entryPoint: string = VIEW_ENTRYPOINT
): Promise<ViewerBundle> => {
	// esm, inlined by the shell as <script type="module">. One file, no
	// imports left: the host's sandbox has nowhere to load a second one from.
	const result = await build({
		// Input paths in the metafile are relative to this.
		absWorkingDir: REPOSITORY_ROOT,
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		// Keeps the license comments the bundled packages carry, at the end
		// of the script. Most carry none, which is why the banner below
		// names every package.
		legalComments: "eof",
		logLevel: "silent",
		metafile: true,
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
	// Only the files that left bytes in the output: tree shaking drops whole
	// packages the view imports nothing from.
	const inputs = Object.values(result.metafile.outputs).flatMap((out) =>
		Object.entries(out.inputs)
			.filter(([, input]) => input.bytesInOutput > 0)
			.map(([path]) => path)
	);
	const packages = bundledPackages(inputs);
	return {
		html: viewerDocument(`${noticeBanner(packages)}\n${output.text}`),
		packages,
	};
};

/** The viewer document, with the view's script bundled and inlined. */
export const buildViewerHtml = async (
	entryPoint: string = VIEW_ENTRYPOINT
): Promise<string> => (await bundleViewer(entryPoint)).html;
