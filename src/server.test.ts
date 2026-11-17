import {
	InMemoryTransport,
	type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "vitest";
import { createServer, readPackageVersion, SERVER_NAME } from "./server.ts";

const SEMVER = /^\d+\.\d+\.\d+/;

describe("createServer", () => {
	test("answers initialize with the server's name and package version", async () => {
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const server = createServer();
		await server.connect(serverSide);

		const reply = new Promise<JSONRPCMessage>((resolve) => {
			clientSide.onmessage = resolve;
		});
		await clientSide.start();
		await clientSide.send({
			id: 1,
			jsonrpc: "2.0",
			method: "initialize",
			params: {
				capabilities: {},
				clientInfo: { name: "test-client", version: "0.0.0" },
				protocolVersion: "2025-06-18",
			},
		});

		expect(await reply).toMatchObject({
			id: 1,
			result: {
				protocolVersion: "2025-06-18",
				serverInfo: { name: SERVER_NAME, version: readPackageVersion() },
			},
		});
		await server.close();
	});

	test("reads a semver version from package.json", () => {
		expect(readPackageVersion()).toMatch(SEMVER);
	});
});
