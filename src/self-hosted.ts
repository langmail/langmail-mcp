// Entrypoint of the self-hosted MCP server, and the langmail-mcp package's bin
// once bundled (scripts/build-package.ts). From source: `bun run start:self-hosted`, or
// `bun --no-env-file src/self-hosted.ts`. Without --no-env-file, Bun loads the
// repo's .env.development, whose MCP_PUBLIC_URL points the
// minted attachment links at the hosted dev server. Settings and what this mode leaves out:
// docs/self-hosted.md. The hosted server is src/index.ts.
//
// Logs go to stderr, because over stdio stdout carries the protocol. The
// logger picks its stream when it loads, so the variable is set before the
// server's modules are imported; a static import would load them first.

process.env.MCP_LOG_STDERR = '1'
process.env.SERVICE_NAME ??= 'mcp-self-hosted'

const { run } = await import('./self-hosted/main.ts')
await run()
