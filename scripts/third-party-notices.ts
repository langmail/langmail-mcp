// `npm run notices`: writes THIRD_PARTY_NOTICES.md from what the bundler put
// into the email viewer. Run it after a dependency of the viewer changes.

import { writeFile } from "node:fs/promises";
import { NOTICES_FILE, renderNotices } from "./third-party.ts";
import { bundleViewer } from "./viewer-bundle.ts";

const { packages } = await bundleViewer();
await writeFile(NOTICES_FILE, renderNotices(packages));
