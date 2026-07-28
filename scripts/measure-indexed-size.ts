// Measures each MCP tool's "indexed document" size — the surface a
// BM25-based tool search ranks on: name, description, argument names, and
// argument descriptions (approximated as description length + serialized
// input-schema JSON, in characters).
//
// Run from the repo root: bun services/mcp/scripts/measure-indexed-size.ts
//
// Baseline on 2026-07-28 (before the fix): update_calendar_event totals
// 8,047 chars vs. delete_calendar_event's 1,673 and a median near 1,400.
// The plan's acceptance target is a total under ~2,500 for every calendar
// and mail-rule tool.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const server = new McpServer({ name: 'measure', version: '0.0.0' })

// Registration only reads the metadata; handlers never run, so a Proxy of
// throwing no-ops satisfies every Deps shape.
const noDeps = new Proxy(
  {},
  {
    get: (): never => {
      throw new Error('measure-indexed-size: deps are never called')
    },
  }
) as never
const getToken = (): string => 'measure'

const toolModules = [
  'create-calendar-event',
  'create-calendar',
  'create-mail-rule',
  'delete-calendar-event',
  'delete-mail-rule',
  'download-attachment',
  'get-email',
  'get-thread',
  'list-calendar-events',
  'list-calendars',
  'list-mail-rules',
  'preview-mail-rule',
  'respond-to-event',
  'search-emails',
  'update-calendar-event',
  'update-mail-rule',
]

const toolsDir = new URL('../src/tools/', import.meta.url)
for (const name of toolModules) {
  const mod = await import(new URL(`${name}.ts`, toolsDir).pathname)
  const register = Object.entries(mod).find(([key]) => key.startsWith('register'))?.[1] as (
    server: McpServer,
    deps: never,
    getToken: () => string
  ) => void
  register(server, noDeps, getToken)
}

interface RegisteredTool {
  description?: string
  inputSchema: z.ZodRawShape | z.ZodObject
}
// Private SDK field — fine for a measurement script.
const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools

const rows = Object.entries(registered).map(([name, tool]) => {
  const shape = 'shape' in tool.inputSchema ? (tool.inputSchema as z.ZodObject).shape : tool.inputSchema
  const schemaJson = JSON.stringify(z.toJSONSchema(z.object(shape))).length
  const description = (tool.description ?? '').length
  return { description, name, schemaJson, total: description + schemaJson }
})

rows.sort((a, b) => b.total - a.total)
for (const row of rows) {
  console.log(`${row.name}\tdesc=${row.description}\tschemaJson=${row.schemaJson}\ttotal=${row.total}`)
}
