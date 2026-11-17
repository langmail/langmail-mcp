#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
	type Config,
	ConfigError,
	type HttpTransportConfig,
	loadConfig,
} from "./config.ts";
import { createRequestGuard } from "./http/guard.ts";
import { startHttpListener } from "./http/listener.ts";
import { createFetchHandler, healthRoute } from "./http/routes.ts";
import { createServer } from "./mcp/handler.ts";
import { MCP_PATH, mcpRoutes } from "./mcp/http.ts";

const EXIT_MISCONFIGURED = 1;

// stdout belongs to the MCP transport: everything a person should read goes
// to stderr.
const say = (message: string): void => {
	process.stderr.write(`${message}\n`);
};

// Serves MCP over Streamable HTTP until the process is told to stop.
const serveHttp = async (
	config: Config,
	transport: HttpTransportConfig
): Promise<void> => {
	const listener = await startHttpListener({
		fetch: createFetchHandler(
			[healthRoute, ...mcpRoutes(config, transport.authToken)],
			{
				guard: createRequestGuard({
					host: transport.host,
					publicUrl: transport.publicUrl,
				}),
			}
		),
		host: transport.host,
		port: transport.port,
	});
	say(`langmail-mcp: listening on ${listener.origin}${MCP_PATH}`);

	// Stop accepting, let requests in flight finish, then leave. A second
	// signal while that is under way exits at once.
	let stopping = false;
	const stop = (): void => {
		if (stopping) {
			process.exit(EXIT_MISCONFIGURED);
		}
		stopping = true;
		listener
			.close()
			.then(() => process.exit(0))
			.catch(() => process.exit(EXIT_MISCONFIGURED));
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
};

const main = async (): Promise<void> => {
	const { config, warnings } = loadConfig(process.env, process.argv.slice(2));
	for (const warning of warnings) {
		say(`langmail-mcp: warning: ${warning}`);
	}
	if (config.transport.kind === "http") {
		await serveHttp(config, config.transport);
		return;
	}
	// No request goes to Stalwart here: the MCP handshake must not wait on, or
	// fail with, the mail server. The credential is checked on the first tool
	// call.
	await createServer(config).connect(new StdioServerTransport());
};

try {
	await main();
} catch (error) {
	if (error instanceof ConfigError) {
		say(error.message);
	} else {
		say(
			`langmail-mcp: failed to start: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	process.exitCode = EXIT_MISCONFIGURED;
}
