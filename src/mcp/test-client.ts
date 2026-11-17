// A minimal MCP client for unit tests: drives a server over an in-memory
// transport the way a client would, handshake included. Nothing is dialled.

import {
	InMemoryTransport,
	type JSONRPCMessage,
	type McpServer,
} from "@modelcontextprotocol/server";

export interface RpcResult {
	content?: { text: string; type: string }[];
	isError?: boolean;
	[key: string]: unknown;
}

export interface RpcMessage {
	error?: { code: number; message: string };
	result?: RpcResult;
}

export interface TestClient {
	/** Sends one request and resolves with the answer, be it a result or an error. */
	ask: (
		method: string,
		params?: Record<string, unknown>
	) => Promise<RpcMessage>;
	close: () => Promise<void>;
	/** The result of the `initialize` request the handshake sent. */
	initialized: RpcResult;
	request: (
		method: string,
		params?: Record<string, unknown>
	) => Promise<RpcResult>;
}

export const connect = async (server: McpServer): Promise<TestClient> => {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const waiting = new Map<number, (message: JSONRPCMessage) => void>();
	clientSide.onmessage = (message) => {
		const id = (message as { id?: number }).id;
		if (id !== undefined) {
			waiting.get(id)?.(message);
		}
	};
	await clientSide.start();
	let nextId = 0;
	const ask = async (
		method: string,
		params: Record<string, unknown> = {}
	): Promise<RpcMessage> => {
		nextId += 1;
		const id = nextId;
		const reply = new Promise<JSONRPCMessage>((resolve) => {
			waiting.set(id, resolve);
		});
		await clientSide.send({ id, jsonrpc: "2.0", method, params });
		return (await reply) as RpcMessage;
	};
	const request = async (
		method: string,
		params: Record<string, unknown> = {}
	): Promise<RpcResult> => {
		const message = await ask(method, params);
		if (!message.result) {
			throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
		}
		return message.result;
	};
	const initialized = await request("initialize", {
		capabilities: {},
		clientInfo: { name: "test-client", version: "0.0.0" },
		protocolVersion: "2025-06-18",
	});
	await clientSide.send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	return { ask, close: () => server.close(), initialized, request };
};

export const textOf = (result: RpcResult): string =>
	result.content?.map((part) => part.text).join("\n") ?? "";
