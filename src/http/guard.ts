// Keeps web pages away from the listener.
//
// A page open in the user's browser can make that browser send requests to a
// server on the same machine or network. Two checks stop it, as the MCP
// specification asks of HTTP servers:
//
//   Origin — a browser names the page a cross-site request comes from. A
//     request whose Origin is not this server's own address is refused.
//     Clients that are not browsers send no Origin and pass.
//   Host — a page can point a hostname of its own at 127.0.0.1 ("DNS
//     rebinding") so the browser treats the server as same-origin. Such a
//     request still carries the page's hostname in Host. When the listener is
//     bound to loopback, only loopback names (and the public URL's) are
//     accepted there. A listener bound to another address is reached under
//     names this process cannot know (a reverse proxy's, an IP), so Host is
//     not checked there.
//
// No CORS headers are sent anywhere, so a browser also refuses to let a page
// read an answer or send the Authorization header across origins.

import {
	localhostAllowedHostnames,
	validateHostHeader,
	validateOriginHeader,
} from "@modelcontextprotocol/server";
import { logger } from "../logger.ts";
import { isLoopbackHost, urlHostname } from "./hosts.ts";

const HTTP_FORBIDDEN = 403;

const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", ""]);

export type RequestGuard = (req: Request) => Response | undefined;

export interface RequestGuardOptions {
	// The address the listener is bound to.
	host: string;
	// The URL callers reach the listener under, when it is not the bind address.
	publicUrl?: string;
}

const forbidden = (): Response =>
	new Response(`${JSON.stringify({ error: "forbidden" })}\n`, {
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
		},
		status: HTTP_FORBIDDEN,
	});

export const createRequestGuard = (
	options: RequestGuardOptions
): RequestGuard => {
	const own = new Set(localhostAllowedHostnames());
	if (!WILDCARD_HOSTS.has(options.host)) {
		own.add(urlHostname(options.host).toLowerCase());
	}
	if (options.publicUrl !== undefined) {
		own.add(new URL(options.publicUrl).hostname.toLowerCase());
	}
	const allowed = [...own];
	const checkHost = isLoopbackHost(options.host);

	return (req) => {
		const origin = validateOriginHeader(req.headers.get("origin"), allowed);
		if (!origin.ok) {
			// The reason only: the header is whatever the page chose to be.
			logger.warn({ reason: origin.errorCode }, "http request refused");
			return forbidden();
		}
		if (checkHost) {
			const host = validateHostHeader(req.headers.get("host"), allowed);
			if (!host.ok) {
				logger.warn({ reason: host.errorCode }, "http request refused");
				return forbidden();
			}
		}
	};
};
