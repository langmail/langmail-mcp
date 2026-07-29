// Measures each MCP tool's "indexed document" size — the surface a
// BM25-based tool search ranks on. Two numbers per tool:
//
//   text  — the ranked *words*: name + description + argument names +
//           argument descriptions. This is what BM25 scores terms against.
//   total — text plus the serialized input-schema JSON, the pessimistic
//           bound if the whole schema is indexed verbatim.
//
// `total` carries an irreducible floor the wording can't touch: zod emits a
// ~380-character regex `pattern` for every `z.iso.datetime()` field, so
// update_calendar_event's four date-time fields alone cost ~1.7k characters
// of noise. Judge wording changes on `text`; use `total` only to compare
// tools with similar field counts.
//
// Run from the repo root: bun services/mcp/scripts/measure-indexed-size.ts
//
// Baseline on 2026-07-28 (before the fix): update_calendar_event totalled
// 8,047 chars (text 4,974) vs. delete_calendar_event's 1,673 (text 1,087)
// and a median near 1,400 — the outlier BM25's length normalisation
// penalises. After the fix it is 5,489 (text 2,337): no longer the largest
// document in the catalogue, and under half its former ranked text.

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

// Discover the tool modules from the directory rather than a hand-maintained
// list, so a tool added to mcp/handler.ts can't be silently missing from the
// measurement. Modules without a `register*` export (result.ts, format.ts,
// shared fixtures, …) are not tools and drop out naturally.
const toolsDir = new URL('../src/tools/', import.meta.url)
const { readdir } = await import('node:fs/promises')
const moduleFiles = (await readdir(toolsDir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()
for (const file of moduleFiles) {
  const mod = await import(new URL(file, toolsDir).pathname)
  const register = Object.entries(mod).find(([key]) => key.startsWith('register'))?.[1] as
    | ((server: McpServer, deps: never, getToken: () => string) => void)
    | undefined
  register?.(server, noDeps, getToken)
}

interface RegisteredTool {
  description?: string
  inputSchema: z.ZodRawShape | z.ZodObject
}
// Private SDK field — fine for a measurement script.
const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools

// Every `description` in a JSON Schema tree, plus the property names that
// carry them — the words a term-frequency index actually sees.
const textOf = (schema: unknown): string => {
  if (Array.isArray(schema)) {
    return schema.map(textOf).join(' ')
  }
  if (typeof schema !== 'object' || schema === null) {
    return ''
  }
  const node = schema as Record<string, unknown>
  const properties = node.properties as Record<string, unknown> | undefined
  return [
    typeof node.description === 'string' ? node.description : '',
    ...Object.keys(properties ?? {}),
    ...Object.values(node).map(textOf),
  ].join(' ')
}

const rows = Object.entries(registered).map(([name, tool]) => {
  const shape = 'shape' in tool.inputSchema ? (tool.inputSchema as z.ZodObject).shape : tool.inputSchema
  const json = z.toJSONSchema(z.object(shape))
  const description = (tool.description ?? '').length
  const text = `${name} ${tool.description ?? ''} ${textOf(json)}`.length
  const schemaJson = JSON.stringify(json).length
  return { description, name, schemaJson, text, total: description + schemaJson }
})

rows.sort((a, b) => b.text - a.text)
for (const row of rows) {
  console.log(
    `${row.name}\tdesc=${row.description}\ttext=${row.text}\tschemaJson=${row.schemaJson}\ttotal=${row.total}`
  )
}
