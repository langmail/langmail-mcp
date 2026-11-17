import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, test, vi } from "vitest";
import { logger } from "../logger.ts";
import { instrumentToolLogging } from "./tool-logging.ts";

type Registered = (args: unknown, ctx: unknown) => Promise<unknown>;

// A stand-in for the one method the wrapper patches, so the test drives a tool
// callback directly instead of through a transport.
const makeServer = (
	beforeCall?: () => Promise<void>
): {
	registered: Map<string, Registered>;
	server: McpServer;
} => {
	const registered = new Map<string, Registered>();
	const server = {
		registerTool: (name: string, _config: unknown, cb: Registered) => {
			registered.set(name, cb);
			return { name };
		},
	} as unknown as McpServer;
	instrumentToolLogging(server, beforeCall);
	return { registered, server };
};

const register = (server: McpServer, name: string, cb: () => unknown): void => {
	// The real McpServer.registerTool is overloaded and generic over the tool's input schema; the
	// fake above is not, so the call is made through the loose shape.
	(
		server.registerTool as unknown as (
			n: string,
			c: unknown,
			f: () => unknown
		) => unknown
	)(name, {}, cb);
};

// Spy on the shared logger rather than replacing the module: a replaced
// module would follow every other test in the file that logs.
const withLogSpies = async (
	fn: (spies: {
		error: ReturnType<typeof vi.spyOn>;
		info: ReturnType<typeof vi.spyOn>;
		warn: ReturnType<typeof vi.spyOn>;
	}) => Promise<void>
): Promise<void> => {
	const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
	const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
	try {
		await fn({ error, info, warn });
	} finally {
		info.mockRestore();
		error.mockRestore();
		warn.mockRestore();
	}
};

describe("instrumentToolLogging", () => {
	test("logs name, duration and outcome for a successful call", async () => {
		await withLogSpies(async ({ error, info, warn }) => {
			const { registered, server } = makeServer();
			register(server, "list_calendars", () => ({
				content: [{ text: "2 calendars", type: "text" }],
			}));

			const result = await registered.get("list_calendars")?.({}, {});

			expect(result).toEqual({
				content: [{ text: "2 calendars", type: "text" }],
			});
			expect(error).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(info).toHaveBeenCalledTimes(1);
			const fields = info.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(fields.tool).toBe("list_calendars");
			expect(fields.outcome).toBe("success");
			expect(typeof fields.durationMs).toBe("number");
		});
	});

	// An `isError: true` result is the tool answering the model in-band, not a
	// server fault, so it stays off `error`.
	test("logs an isError result at warn, not error, without quoting its text", async () => {
		await withLogSpies(async ({ error, info, warn }) => {
			const { registered, server } = makeServer();
			register(server, "create_calendar_event", () => ({
				content: [
					{ text: "Conflicts with lunch with bob@example.com", type: "text" },
				],
				isError: true,
			}));

			await registered.get("create_calendar_event")?.({}, {});

			expect(info).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			const fields = warn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(fields.tool).toBe("create_calendar_event");
			expect(fields.outcome).toBe("tool_error");
			expect(JSON.stringify(fields)).not.toContain("bob@example.com");
		});
	});

	test("logs a thrown error by class and rethrows it", async () => {
		await withLogSpies(async ({ error, warn }) => {
			const { registered, server } = makeServer();
			register(server, "search_emails", () => {
				throw new TypeError("fetch failed for alice@example.com");
			});

			const thrown = await registered
				.get("search_emails")?.({}, {})
				.catch((err: unknown) => err);

			expect(thrown).toBeInstanceOf(TypeError);
			expect(warn).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledTimes(1);
			const fields = error.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(fields.tool).toBe("search_emails");
			expect(fields.outcome).toBe("exception");
			expect(fields.errorClass).toBe("TypeError");
			expect(fields.errorMessage).toBe("fetch failed for [email]");
		});
	});

	test("awaits beforeCall ahead of every tool call", async () => {
		await withLogSpies(async ({ info }) => {
			const order: string[] = [];
			const { registered, server } = makeServer(async () => {
				await Promise.resolve();
				order.push("before");
			});
			register(server, "get_email", () => {
				order.push("tool");
				return { content: [] };
			});

			await registered.get("get_email")?.({}, {});
			await registered.get("get_email")?.({}, {});

			expect(order).toEqual(["before", "tool", "before", "tool"]);
			expect(info).toHaveBeenCalledTimes(2);
		});
	});

	test("a beforeCall rejection keeps the tool from running, and is logged and rethrown", async () => {
		await withLogSpies(async ({ error, info }) => {
			const tool = vi.fn(() => ({ content: [] }));
			const { registered, server } = makeServer(() =>
				Promise.reject(new Error("sign-in failed for Basic dXNlcjpwYXNz"))
			);
			register(server, "get_email", tool);

			const thrown = await registered
				.get("get_email")?.({}, {})
				.catch((err: unknown) => err);

			expect((thrown as Error).message).toContain("sign-in failed");
			expect(tool).not.toHaveBeenCalled();
			expect(info).not.toHaveBeenCalled();
			const fields = error.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(fields.tool).toBe("get_email");
			expect(fields.outcome).toBe("exception");
			expect(fields.errorMessage).toBe("sign-in failed for Basic [redacted]");
		});
	});
});
