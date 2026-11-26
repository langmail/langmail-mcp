// The self-hosted MCP server: someone's own Stalwart, a username and an app
// password, no Langmail service. Started by src/self-hosted.ts; the hosted
// server is src/index.ts.
//
// It talks to STALWART_URL only. It builds no Better Auth client, no client
// for Auth's internal endpoints and no calendar feed, so calendar sharing and
// the agent-activity record are off. Log shipping and error tracking follow
// the same Better Stack settings as hosted (logger/), which are unset unless
// the operator sets them.

import { type Readable, type Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { ACCESS_LEVEL_NAMES } from '../access/levels.ts'
import { createAttachmentDownload } from '../attachments/download.ts'
import { createTicketStore } from '../attachments/tickets.ts'
import { createAttachmentUpload } from '../attachments/upload.ts'
import { createUploadTicketStore } from '../attachments/upload-tickets.ts'
import { createImageProxy, createImageProxyStore } from '../email-render/image-proxy.ts'
import { makeJmapLive } from '../jmap/index.ts'
import { initErrorTracking } from '../logger/error-tracking.ts'
import { logger } from '../logger/index.ts'
import { createMcpHandler, createMcpServerFactory, type McpHandlerConfig, type ServerContext } from '../mcp/handler.ts'
import { describeError } from '../observability/errors.ts'
import { checkStalwartCredentials } from './check-credentials.ts'
import { basicAuthorization, defaultPublicUrl, parseSelfHostedConfig, type SelfHostedConfig } from './config.ts'
import { type Listener, listen } from './listen.ts'
import { createSelfHostedRoutes } from './routes.ts'

export interface StartOptions {
  argv: string[]
  env: Record<string, string | undefined>
  // Called once the stdio client has closed the connection and the server
  // has stopped; run() exits the process there. Without it the ticket
  // listener would keep an orphaned process alive after the client quits.
  onStdioClosed?: () => void
  // The stdio transport's streams; process stdin/stdout when left out.
  stdin?: Readable
  stdout?: Writable
}

export interface Started {
  // The HTTP listener's address: /mcp over http, the ticket routes either way.
  listenUrl: string
  publicUrl: string
  stop: () => Promise<void>
  transport: SelfHostedConfig['transport']
}

export type StartResult = { ok: true; started: Started } | { help?: true; message: string; ok: false }

// As in index.ts: an exception escaping a handler is logged, not lost.
const internalError = (error: unknown): Response => {
  logger.error(describeError(error), 'mcp unhandled request error')
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    headers: { 'content-type': 'application/json' },
    status: 500,
  })
}

export const startSelfHosted = async (opts: StartOptions): Promise<StartResult> => {
  const parsed = parseSelfHostedConfig(opts.argv, opts.env)
  if (!parsed.ok) {
    return parsed
  }
  const { config } = parsed
  const authorization = basicAuthorization(config.username, config.password)

  const checked = await checkStalwartCredentials(config.stalwartUrl, config.username, authorization)
  if (!checked.ok) {
    return checked
  }

  // The one context every tool call acts with: the Basic credential goes
  // where the hosted server puts the client's bearer.
  // The principal picks the sending identity: STALWART_EMAIL when set, else
  // the login Stalwart reports.
  const ctx: ServerContext = {
    access: config.access,
    principal: config.email ?? checked.session.principal,
    token: authorization,
    userId: '',
  }

  const jmapLive = makeJmapLive(config.stalwartUrl)
  const tickets = createTicketStore()
  const uploadTickets = createUploadTicketStore()
  const imageTokens = createImageProxyStore()
  const ticketRoutes = {
    attachmentDownload: createAttachmentDownload(jmapLive, tickets),
    attachmentUpload: createAttachmentUpload(jmapLive, uploadTickets),
    imageProxy: createImageProxy(imageTokens),
  }

  // The listener comes first: the tools mint links under its URL, and over
  // stdio with no port set it takes whatever port is free.
  let handleMcp: ((req: Request) => Promise<Response>) | undefined
  const routes = createSelfHostedRoutes({
    ...ticketRoutes,
    ...(config.transport === 'http' && config.authToken
      ? {
          mcp: {
            authToken: config.authToken,
            handle: (req: Request) =>
              handleMcp ? handleMcp(req) : Promise.resolve(new Response(null, { status: 503 })),
          },
        }
      : {}),
  })
  let server: Listener
  try {
    server = await listen({ fetch: routes, host: config.host, onError: internalError, port: config.port ?? 0 })
  } catch (error) {
    return {
      message: `Could not listen on ${config.host}:${config.port ?? 0} (${error instanceof Error ? error.message : String(error)}). Check MCP_HOST (--host) and MCP_PORT (--port).`,
      ok: false,
    }
  }
  const { port } = server
  const publicUrl = config.publicUrl ?? defaultPublicUrl(config.host, port)

  const mcpConfig: McpHandlerConfig = {
    imageTokens,
    live: jmapLive,
    mode: 'self-hosted',
    publicUrl,
    recordAgentActivity: () => Promise.resolve(),
    stalwartUrl: config.stalwartUrl,
    tickets,
    uploadTickets,
  }

  let closeStdio: (() => Promise<void>) | undefined
  if (config.transport === 'http') {
    const handler = createMcpHandler(mcpConfig)
    const authCtx = { ...ctx, exp: 0 }
    handleMcp = (req) => handler(req, authCtx)
  } else {
    const mcpServer = createMcpServerFactory(mcpConfig)(ctx)
    const transport = new StdioServerTransport(opts.stdin, opts.stdout)
    await mcpServer.connect(transport)
    closeStdio = () => mcpServer.close()
    // The client closing stdin ends the session: stop the listener too.
    mcpServer.server.onclose = () => {
      closeStdio = undefined
      server.stop().then(
        () => opts.onStdioClosed?.(),
        () => opts.onStdioClosed?.()
      )
    }
  }

  const listenUrl = defaultPublicUrl(config.host, port)
  logger.info(
    { access: config.access, jmapUpstream: config.stalwartUrl, listenUrl, publicUrl, transport: config.transport },
    `self-hosted mcp ready at ${ACCESS_LEVEL_NAMES[config.access]} access`
  )

  return {
    ok: true,
    started: {
      listenUrl,
      publicUrl,
      stop: async () => {
        await closeStdio?.()
        await server.stop()
      },
      transport: config.transport,
    },
  }
}

// What the entrypoint runs: start, or say why not on stderr and exit non-zero.
export const run = async (): Promise<void> => {
  // A no-op unless NODE_ENV=production and BETTERSTACK_ERRORS_DSN are set.
  initErrorTracking('mcp-self-hosted')
  const result = await startSelfHosted({
    argv: process.argv.slice(2),
    env: process.env,
    onStdioClosed: () => process.exit(0),
  })
  if (!result.ok) {
    if (result.help) {
      process.stdout.write(result.message)
      process.exit(0)
    }
    process.stderr.write(`${result.message}\n`)
    process.exit(2)
  }
}
