// Logs one line per tool invocation: name, duration, outcome.
//
// Every tool is registered against a `McpServer` in one place
// (`createServer`), so instrumenting `registerTool` on that instance covers
// the whole surface — one wrapper rather than an edit per tool file.
//
// The two failure outcomes are not the same severity:
//
//   tool_error — the tool returned `isError: true`. That is the MCP contract
//     for answering the calling model in-band: "no such thread", "query must
//     not be empty", "event end must be after its start". The server worked;
//     the answer is no. Logged at `warn`.
//   exception — the tool threw. No tool throws to express a designed answer,
//     so a throw is always an upstream or programming fault. Logged at `error`.
//
// Two tools catch a genuine fault to return it in-band: send_draft and
// reply_to_message turn a failed submission into a result that says whether
// the message may have gone out (and, for a reply, names the draft it left
// behind). Both log their own `error` line before returning that result.
//
// The result text itself never appears in either line: tool results quote
// event content and mailbox addresses, and log lines get shown, stored and
// pasted into bug reports.

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { logger } from "../logger.ts";
import { describeError } from "../observability/errors.ts";

// `registerTool` is overloaded (schema objects, and a deprecated raw-shape
// form) and its ToolCallback is a conditional type over the tool's input
// schema, so it cannot be wrapped generically. The wrapper is opaque in the
// config and the arguments it forwards, and is cast back to the SDK's type.
type OpaqueToolCallback = (...args: unknown[]) => unknown;
type OpaqueRegisterTool = (
	name: string,
	config: unknown,
	cb: OpaqueToolCallback
) => RegisteredTool;

const isErrorResult = (result: unknown): boolean =>
	typeof result === "object" &&
	result !== null &&
	(result as { isError?: unknown }).isError === true;

// Registers tool call logging on a server instance. Call before the tools are
// registered — it patches `registerTool`, so only later registrations are wrapped.
//
// `beforeCall` runs ahead of every tool callback and is awaited; a rejection
// is logged and thrown exactly like the tool's own. The server signs in to
// Stalwart there (see `handler.ts`), the way the hosted service authenticates
// a request before it reaches a tool.
export const instrumentToolLogging = (
	server: McpServer,
	beforeCall: () => Promise<void> = () => Promise.resolve()
): void => {
	const register = server.registerTool.bind(
		server
	) as unknown as OpaqueRegisterTool;

	const instrumented: OpaqueRegisterTool = (name, config, call) => {
		const wrapped = async (...args: unknown[]): Promise<unknown> => {
			const startedAt = performance.now();
			try {
				await beforeCall();
				const result = await call(...args);
				const durationMs = Math.round(performance.now() - startedAt);
				if (isErrorResult(result)) {
					logger.warn(
						{ durationMs, outcome: "tool_error", tool: name },
						"mcp tool returned an error result"
					);
				} else {
					logger.info(
						{ durationMs, outcome: "success", tool: name },
						"mcp tool completed"
					);
				}
				return result;
			} catch (error) {
				const durationMs = Math.round(performance.now() - startedAt);
				logger.error(
					{
						...describeError(error),
						durationMs,
						outcome: "exception",
						tool: name,
					},
					"mcp tool failed"
				);
				throw error;
			}
		};
		return register(name, config, wrapped);
	};

	server.registerTool = instrumented as unknown as typeof server.registerTool;
};
