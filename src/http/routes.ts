// The routes one HTTP listener serves, and the function that dispatches a
// request to them.
//
// A listener is a list of routes; whoever starts it decides which. The HTTP
// transport serves `/mcp` and `/healthz`. Routes that hand out files under an
// unguessable link can be added to the same list, or served by a listener of
// their own that has no `/mcp` at all.

import { logger } from "../logger.ts";
import { describeError } from "../observability/errors.ts";
import type { RequestGuard } from "./guard.ts";

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;

export interface Route {
	// Answers a request whose path matched. A route decides for itself what it
	// requires of the caller (the bearer token, an unguessable path segment).
	handle: (req: Request, url: URL) => Response | Promise<Response>;
	// The name the route's requests are logged under: one line each with
	// method, status and duration. Leave it out for a route that is polled
	// (health) or whose path is itself a secret. The path is never logged.
	logAs?: string;
	// The path the route serves. Ending in a slash, it serves every path below
	// it ("/attachments/" serves "/attachments/abc"); otherwise exactly this
	// path.
	path: string;
}

export interface FetchHandlerOptions {
	// Runs ahead of every route; a response it returns is the answer.
	guard?: RequestGuard;
}

export type FetchHandler = (req: Request) => Promise<Response>;

const matches = (route: Route, pathname: string): boolean =>
	route.path.endsWith("/")
		? pathname.startsWith(route.path)
		: pathname === route.path;

const notFound = (): Response =>
	new Response("not found\n", {
		headers: { "content-type": "text/plain" },
		status: HTTP_NOT_FOUND,
	});

const internalError = (): Response =>
	new Response(`${JSON.stringify({ error: "internal_error" })}\n`, {
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
		},
		status: HTTP_INTERNAL_ERROR,
	});

// A failure inside a route must not take the listener down or reach the
// caller as a stack trace: it is logged and answered with a bare 500.
const answer = async (
	route: Route,
	req: Request,
	url: URL
): Promise<Response> => {
	try {
		return await route.handle(req, url);
	} catch (error) {
		logger.error(describeError(error), "http unhandled request error");
		return internalError();
	}
};

/** Liveness for a process supervisor or a reverse proxy. It says that the process answers and nothing else. */
export const healthRoute: Route = {
	handle: () =>
		new Response("ok\n", { headers: { "content-type": "text/plain" } }),
	path: "/healthz",
};

/**
 * Builds the request handler for a list of routes. The first route whose path
 * matches answers; a path no route serves is a 404.
 */
export const createFetchHandler = (
	routes: readonly Route[],
	options: FetchHandlerOptions = {}
): FetchHandler => {
	return async (req) => {
		const refused = options.guard?.(req);
		if (refused) {
			return refused;
		}
		const url = new URL(req.url);
		const route = routes.find((candidate) => matches(candidate, url.pathname));
		if (!route) {
			return notFound();
		}
		if (route.logAs === undefined) {
			return answer(route, req, url);
		}
		// Logged on completion, so a rejected request is on record too. Method,
		// route name, status and duration carry no address and no credential.
		const startedAt = performance.now();
		const res = await answer(route, req, url);
		logger.info(
			{
				durationMs: Math.round(performance.now() - startedAt),
				method: req.method,
				route: route.logAs,
				status: res.status,
			},
			"mcp request"
		);
		return res;
	};
};
