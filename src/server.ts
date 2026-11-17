import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";

export const SERVER_NAME = "langmail-mcp";

/** The package version, read from the `package.json` that ships next to `dist/`. */
export function readPackageVersion(): string {
	const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
	const { version } = JSON.parse(raw) as { version: string };
	return version;
}

export function createServer(): McpServer {
	return new McpServer({ name: SERVER_NAME, version: readPackageVersion() });
}
