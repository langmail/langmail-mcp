import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Config } from "../config.ts";
import type { JmapLive } from "../jmap/index.ts";
import { logger } from "../logger.ts";
import { createRuntime, createServer } from "./handler.ts";
import {
	connect,
	type RpcMessage,
	textOf as resultText,
	type TestClient,
} from "./test-client.ts";

const config: Config = {
	allowRemoteImages: false,
	allowUnsubscribePost: false,
	credential: "Bearer token",
	stalwartUrl: "https://mail.example.com",
	transport: { kind: "stdio" },
};

// The server signs in before a tool runs; this answers that from memory.
// Every call here is answered before a handler would reach Stalwart, so the
// placeholder URL is never dialled.
const live: JmapLive = {
	getSession: () =>
		Promise.resolve({
			apiUrl: "https://mail.example.com/jmap/",
			downloadUrl: "https://mail.example.com/jmap/download/",
			primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
			uploadUrl: "https://mail.example.com/jmap/upload/",
			username: "user@example.com",
		}),
	resolveAccountId: () => Promise.resolve("acct-1"),
};

let client: TestClient;

beforeAll(async () => {
	client = await connect(createServer(config, createRuntime(config, live)));
});

afterAll(async () => {
	await client.close();
});

// One tools/call through the real server, the path a client's call takes.
const callTool = (
	name: string,
	args: Record<string, unknown>
): Promise<RpcMessage> => client.ask("tools/call", { arguments: args, name });

const textOf = (message: RpcMessage): string =>
	message.result ? resultText(message.result) : "";

describe("tools/call through the MCP handler", () => {
	test("answers input that fails the schema in-band, naming the field", async () => {
		const message = await callTool("delete_mail_rule", {});

		expect(message.error).toBeUndefined();
		expect(message.result?.isError).toBe(true);
		expect(textOf(message)).toContain("ruleId");
	});

	// search_emails with no filter passes the schema and is refused by the tool
	// itself, so this also checks that instrumentToolLogging wraps tools
	// registered on the real, overloaded McpServer.registerTool.
	test("returns the tool's own refusal and logs it as a tool_error", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			const message = await callTool("search_emails", {});

			expect(message.result?.isError).toBe(true);
			expect(textOf(message)).not.toContain("Input validation error");
			const fields = warn.mock.calls.map(
				(call) => call[0] as Record<string, unknown>
			);
			expect(fields).toContainEqual(
				expect.objectContaining({
					outcome: "tool_error",
					tool: "search_emails",
				})
			);
		} finally {
			warn.mockRestore();
		}
	});

	// The schema refuses what the wall-clock parser cannot read, so the call is
	// answered before the handler runs and nothing reaches the calendar.
	test.each([
		[
			"create_calendar_event",
			{
				end: "2026-10-03T11:00:00",
				start: "2026-10-03T10:00",
				title: "Standup",
			},
		],
		["update_calendar_event", { start: "2026-10-03T10:00", uid: "event-1" }],
		[
			"update_calendar_event",
			{ end: "2026-10-03T11:00", start: "2026-10-03T10:00", uid: "event-1" },
		],
		[
			"update_calendar_event",
			{ end: "2026-10-03T11:00:00.1234", uid: "event-1" },
		],
	])(
		"%p refuses a date-time the parser cannot read, in-band",
		async (name, args) => {
			const message = await callTool(name, args);

			expect(message.error).toBeUndefined();
			expect(message.result?.isError).toBe(true);
			expect(textOf(message)).toContain("a date-time with seconds");
		}
	);

	test("rejects an unknown tool with a JSON-RPC invalid-params error", async () => {
		const message = await callTool("no_such_tool", {});

		expect(message.result).toBeUndefined();
		expect(message.error?.code).toBe(-32_602);
	});
});
