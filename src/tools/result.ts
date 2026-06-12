// Shared MCP tool result shape + small constructors. The index signature
// matches what the SDK's tool callback expects to return.

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

export const textResult = (text: string): ToolResult => ({
  content: [{ text, type: 'text' }],
})

export const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: 'text' }],
  isError: true,
})
