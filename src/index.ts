#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ConfigError, loadConfig } from "./config.ts";
import { createServer } from "./mcp/handler.ts";

const EXIT_MISCONFIGURED = 1;

// stdout belongs to the MCP transport: everything a person should read goes
// to stderr.
const say = (message: string): void => {
	process.stderr.write(`${message}\n`);
};

const main = async (): Promise<void> => {
	const { config, warnings } = loadConfig(process.env, process.argv.slice(2));
	for (const warning of warnings) {
		say(`langmail-mcp: warning: ${warning}`);
	}
	if (config.transport.kind === "http") {
		throw new ConfigError([
			"The HTTP transport (--http, MCP_TRANSPORT=http) is not available in this version yet. Run without it to use stdio.",
		]);
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
