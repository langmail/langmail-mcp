// The file links a server hands to the agent, and where they are served.
//
// Some tools answer with a link instead of content: download_attachment and
// download_email with a URL to fetch, upload_attachments with URLs to PUT a
// file to. The agent moves the bytes with curl, so they never pass through
// the conversation. Each link carries an unguessable ticket, and the routes
// here redeem it without asking for anything else. preview_email puts the
// same kind of link into the email it shows: one per inline image, and, only
// when the user has turned remote images on, one per remote image.
//
// The HTTP transport serves these routes on its own listener, next to `/mcp`.
// The stdio transport has no listener, so the runtime starts one for the links
// alone when a tool first hands one out: bound to loopback, always, with no
// `/mcp` and no health route on it. The agent runs on the same computer, and
// nothing leaves it. A stdio server that never hands out a link opens no port.

import { createAttachmentDownload } from "../attachments/download.ts";
import { attachmentRoutes } from "../attachments/routes.ts";
import { createAttachmentUpload } from "../attachments/upload.ts";
import {
	createImageProxy,
	imageProxyRoute,
} from "../email-render/image-proxy.ts";
import { createRequestGuard } from "../http/guard.ts";
import { type HttpListener, startHttpListener } from "../http/listener.ts";
import { createFetchHandler, type Route } from "../http/routes.ts";
import { logger } from "../logger.ts";
import type { ServerRuntime } from "./handler.ts";

const LOOPBACK = "127.0.0.1";
const ANY_FREE_PORT = 0;

/** Every route that redeems a link minted by a tool of this runtime. */
export const linkRoutes = (runtime: ServerRuntime): Route[] => [
	...attachmentRoutes(
		createAttachmentDownload(runtime.jmapLive, runtime.tickets),
		createAttachmentUpload(runtime.jmapLive, runtime.uploadTickets)
	),
	// The image proxy fetches from hosts a sender chose. Without the user's
	// opt-in the runtime has no token store, and the route does not exist.
	...(runtime.imageTokens
		? [imageProxyRoute(createImageProxy(runtime.imageTokens))]
		: []),
];

/**
 * Starts the loopback listener that serves the link routes of a stdio server.
 * Mint links under its `origin`.
 *
 * `port` is the one the user asked for, if any. When it is taken (a second
 * agent session started the same server), a free port is used instead and a
 * warning logged: a taken port must not keep the server from starting. The
 * listener does not keep the process running; it ends with the process, after
 * transfers in flight.
 */
export const startLinkListener = async (
	runtime: ServerRuntime,
	port: number = ANY_FREE_PORT
): Promise<HttpListener> => {
	const listenOn = (candidate: number): Promise<HttpListener> =>
		startHttpListener({
			fetch: createFetchHandler(linkRoutes(runtime), {
				guard: createRequestGuard({ host: LOOPBACK }),
			}),
			host: LOOPBACK,
			keepsProcessAlive: false,
			port: candidate,
		});
	if (port === ANY_FREE_PORT) {
		return await listenOn(ANY_FREE_PORT);
	}
	try {
		return await listenOn(port);
	} catch {
		logger.warn(
			{ port },
			"the port set in MCP_PORT cannot be used for file links; using a free port instead"
		);
		return await listenOn(ANY_FREE_PORT);
	}
};
