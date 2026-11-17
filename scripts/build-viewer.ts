// `npm run build` step: writes the bundled email viewer to
// dist/email-render/email-viewer.html, where the server reads it.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { buildViewerHtml } from "./viewer-bundle.ts";

const OUT_DIR = new URL("../dist/email-render/", import.meta.url);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL("email-viewer.html", OUT_DIR), await buildViewerHtml());
// tsc compiles everything under src/, the view's source included. The view
// ships inside the HTML document; its unbundled copy is not part of the
// package.
await rm(new URL("viewer/", OUT_DIR), { force: true, recursive: true });
