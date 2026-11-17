// The MCP endpoint of the HTTP transport: `/mcp`, behind the bearer token.
//
// Stateless: every request gets a fresh `McpServer` and a fresh Streamable
// HTTP transport, and all of them share one runtime (the JMAP session cache
// and the signed-in principal). No session lives between two requests, so
// there is nothing to expire and nothing to look up; the token is checked on
// every request, before its body is read.

import { legacyStatelessFallback } from "@modelcontextprotocol/server";
import type { Config } from "../config.ts";
import { createBearerGate } from "../http/bearer.ts";
import type { Route } from "../http/routes.ts";
import { logger } from "../logger.ts";
import { describeError } from "../observability/errors.ts";
import { createRuntime, createServer, type ServerRuntime } from "./handler.ts";

export const MCP_PATH = "/mcp";

/**
 * The routes that serve MCP over Streamable HTTP. `POST /mcp` carries the
 * protocol; the SDK answers other methods with 405, because a stateless
 * server has no stream to open with GET and no session to end with DELETE.
 */
export const mcpRoutes = (
	config: Config,
	authToken: string,
	runtime: ServerRuntime = createRuntime(config)
): Route[] => {
	const authorize = createBearerGate(authToken);
	const serve = legacyStatelessFallback(
		() => createServer(config, runtime),
		(error) => logger.error(describeError(error), "mcp transport error")
	);
	const handle = (req: Request): Response | Promise<Response> =>
		authorize(req) ?? serve(req);
	// One name for both: `/mcp/<anything>` is the same handler, and the path
	// below it is whatever the caller sent.
	return [
		{ handle, logAs: MCP_PATH, path: MCP_PATH },
		{ handle, logAs: MCP_PATH, path: `${MCP_PATH}/` },
	];
};
