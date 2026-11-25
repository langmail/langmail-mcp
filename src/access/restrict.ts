// Offers an agent only the tools its access level allows (levels.ts).
//
// A tool outside the level is never registered, so tools/list leaves it out.
// A client may still call it from a tool list it cached at a higher level; that
// call gets an in-band `isError` result that names the level, says nothing
// happened and where the user changes the level, rather than the SDK's
// JSON-RPC "Tool X not found", which gives the model no reason and no next step.

import { type McpServer, type RegisteredTool } from '@modelcontextprotocol/server'

import { logger } from '../logger/index.ts'
import { type ServerMode } from '../mode.ts'
import { errorResult, type ToolResult } from '../tools/result.ts'
import { ACCESS_LEVEL_NAMES, type AccessLevel, allows, isToolName } from './levels.ts'

const ALLOWS: Record<Exclude<AccessLevel, 'everything'>, string> = {
  'no-send':
    'which lets it read and change the user’s own mail, drafts, calendars and contacts but not send mail or reach anyone else',
  'read-only': 'which lets it read mail, calendars, contacts and mail rules but not change or send anything',
}

// Where the user changes the level.
export const whereToChange = (mode: ServerMode): string =>
  mode === 'self-hosted' ? 'with the --access option the server is started with' : 'under Access in Langmail'

const refusalText = (tool: string, level: AccessLevel, mode: ServerMode): string => {
  const allowed = level === 'everything' ? '' : `, ${ALLOWS[level]}`
  return `${tool} is not available: the user connected this agent with ${ACCESS_LEVEL_NAMES[level]} access${allowed}. Nothing was changed or sent. The user can change the access level ${whereToChange(mode)}.`
}

// See tool-logging.ts for why both are opaque.
type OpaqueRegisterTool = (name: string, config: unknown, cb: (...args: unknown[]) => unknown) => RegisteredTool
type OpaqueSetRequestHandler = (method: string, ...rest: unknown[]) => void
type OpaqueRequestHandler = (request: unknown, ctx: unknown) => unknown

const calledToolName = (request: unknown): unknown =>
  (request as { params?: { name?: unknown } } | undefined)?.params?.name

// Call right after constructing the server, before any registerTool call and
// before instrumentToolLogging, so excluded tools never reach the logging
// wrapper and their refusals record no agent activity.
export const restrictToAccess = (server: McpServer, level: AccessLevel, mode: ServerMode): void => {
  const excluded = new Set<string>()

  const register = server.registerTool.bind(server) as unknown as OpaqueRegisterTool
  const restricted: OpaqueRegisterTool = (name, config, cb) => {
    if (!isToolName(name)) {
      throw new Error(`Tool ${name} has no access level: add it to TOOL_ACCESS in src/access/levels.ts`)
    }
    if (allows(level, name)) {
      return register(name, config, cb)
    }
    excluded.add(name)
    // Nothing in this codebase uses the handle registerTool returns; an
    // excluded tool has none to give.
    return undefined as unknown as RegisteredTool
  }
  server.registerTool = restricted as unknown as typeof server.registerTool

  // McpServer installs its tools/call handler on the first registerTool. Wrap
  // it as it is installed, so a call to an excluded tool is answered here.
  const lowLevel = server.server
  const setRequestHandler = lowLevel.setRequestHandler.bind(lowLevel) as unknown as OpaqueSetRequestHandler
  const patched: OpaqueSetRequestHandler = (method, ...rest) => {
    const handler = rest.at(-1)
    if (method !== 'tools/call' || rest.length !== 1 || typeof handler !== 'function') {
      setRequestHandler(method, ...rest)
      return
    }
    const call = handler as OpaqueRequestHandler
    const guarded: OpaqueRequestHandler = (request, ctx) => {
      const name = calledToolName(request)
      if (typeof name === 'string' && excluded.has(name)) {
        logger.warn({ access: level, outcome: 'not_in_access_level', tool: name }, 'mcp tool outside the access level')
        return Promise.resolve<ToolResult>(errorResult(refusalText(name, level, mode)))
      }
      return call(request, ctx)
    }
    setRequestHandler(method, guarded)
  }
  lowLevel.setRequestHandler = patched as unknown as typeof lowLevel.setRequestHandler
}
