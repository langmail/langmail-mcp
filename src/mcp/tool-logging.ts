// Logs one line per tool invocation: name, duration, outcome.
//
// Every tool is registered against a fresh `McpServer` in one place
// (`createMcpHandler`), so instrumenting `registerTool` on that instance
// covers the whole surface — one wrapper rather than an edit per tool file.
//
// An MCP tool error returned as `isError: true` is a successful HTTP response
// but a failed invocation, so it logs at `error` level too. The result text
// itself never appears in the line: tool results quote event content and
// mailbox addresses, and these lines ship off-box.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { logger } from '@langmail/logger'

import { describeError } from '../observability/errors.ts'

// The SDK's ToolCallback is a conditional type over the tool's input shape, so
// it cannot be wrapped generically — the wrapper is opaque in the arguments it
// forwards and is cast back to the callback type registerTool expects.
type OpaqueToolCallback = (...args: unknown[]) => unknown

const isErrorResult = (result: unknown): boolean =>
  typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true

// Registers tool call logging on a server instance. Call before the tools are
// registered — it patches `registerTool`, so only later registrations are wrapped.
export const instrumentToolLogging = (server: McpServer): void => {
  const register = server.registerTool.bind(server)

  const instrumented: typeof server.registerTool = (name, config, cb) => {
    const call = cb as unknown as OpaqueToolCallback
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = performance.now()
      try {
        const result = await call(...args)
        const durationMs = Math.round(performance.now() - startedAt)
        if (isErrorResult(result)) {
          logger.error({ durationMs, outcome: 'tool_error', tool: name }, 'mcp tool failed')
        } else {
          logger.info({ durationMs, outcome: 'success', tool: name }, 'mcp tool completed')
        }
        return result
      } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt)
        logger.error({ ...describeError(error), durationMs, outcome: 'exception', tool: name }, 'mcp tool failed')
        throw error
      }
    }
    return register(name, config, wrapped as unknown as typeof cb)
  }

  server.registerTool = instrumented
}
