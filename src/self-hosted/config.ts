// Settings of the self-hosted MCP server, from flags and environment.
//
// Every setting has an environment variable; all but the two secrets also have
// a flag, which wins over the variable. The secrets (STALWART_PASSWORD,
// MCP_AUTH_TOKEN) have no flag because a flag shows in the process list.
// Parsing is pure: the entrypoint prints the message and exits.

import { parseArgs } from 'node:util'

export type Transport = 'http' | 'stdio'

export interface SelfHostedConfig {
  // Bearer every /mcp request must carry; http only.
  authToken?: string
  // The address mail is sent as, when the login is not an email address and
  // the account has several sending identities (tools/draft-common.ts).
  email?: string
  host: string
  password: string
  // Set by the operator, or derived from host and port once the listener is
  // bound (main.ts).
  port?: number
  publicUrl?: string
  stalwartUrl: string
  transport: Transport
  username: string
}

export type ParseResult = { config: SelfHostedConfig; ok: true } | { message: string; ok: false }

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_HTTP_PORT = 8080
const TRAILING_SLASHES_RE = /\/+$/u

interface Setting {
  env: string
  flag?: string
  what: string
}

const STALWART_URL: Setting = {
  env: 'STALWART_URL',
  flag: '--stalwart-url',
  what: 'the base URL of your Stalwart server, e.g. https://mail.example.com',
}
const STALWART_USERNAME: Setting = {
  env: 'STALWART_USERNAME',
  flag: '--username',
  what: 'the account name you sign in to Stalwart with',
}
const STALWART_PASSWORD: Setting = {
  env: 'STALWART_PASSWORD',
  what: 'an app password for that account (environment only, so it stays out of the process list)',
}
const MCP_AUTH_TOKEN: Setting = {
  env: 'MCP_AUTH_TOKEN',
  what: 'a long random secret every MCP client must send as "Authorization: Bearer <token>"; required with --transport http, on loopback too (environment only)',
}

const describe = (s: Setting): string => `  ${s.env}${s.flag ? ` (${s.flag})` : ''}: ${s.what}`

const USAGE = [
  'Usage: bun --no-env-file src/self-hosted.ts [--transport stdio|http] [--stalwart-url URL] [--username NAME] [--email ADDRESS]',
  '         [--host HOST] [--port PORT] [--public-url URL]',
  'Secrets come from the environment only: STALWART_PASSWORD, and MCP_AUTH_TOKEN for http.',
].join('\n')

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const DIGITS_RE = /^\d+$/u

const parsePort = (raw: string): number | undefined => {
  if (!DIGITS_RE.test(raw)) {
    return undefined
  }
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined
}

const isHttpUrl = (raw: string): boolean => {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

type Flags = Record<string, string | undefined>

const readFlags = (argv: string[]): { flags: Flags } | { message: string } => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'public-url': { type: 'string' },
        'stalwart-url': { type: 'string' },
        transport: { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
      },
      strict: true,
    })
    return { flags: values as Flags }
  } catch (error) {
    return { message: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` }
  }
}

// The flag when given, else the variable; blank counts as unset.
const pick = (flag: string | undefined, variable: string | undefined): string | undefined =>
  nonEmpty(flag) ?? nonEmpty(variable)

interface Raw {
  authToken?: string
  email?: string
  host: string
  password?: string
  portRaw?: string
  publicUrl?: string
  stalwartUrl?: string
  transport: string
  username?: string
}

const readRaw = (flags: Flags, env: Record<string, string | undefined>): Raw => ({
  authToken: nonEmpty(env.MCP_AUTH_TOKEN),
  email: pick(flags.email, env.STALWART_EMAIL),
  host: pick(flags.host, env.MCP_HOST) ?? DEFAULT_HOST,
  // A password may have leading or trailing spaces; only an empty one is unset.
  password: env.STALWART_PASSWORD ? env.STALWART_PASSWORD : undefined,
  portRaw: pick(flags.port, env.MCP_PORT),
  publicUrl: pick(flags['public-url'], env.MCP_PUBLIC_URL),
  stalwartUrl: pick(flags['stalwart-url'], env.STALWART_URL),
  transport: pick(flags.transport, env.MCP_TRANSPORT) ?? 'stdio',
  username: pick(flags.username, env.STALWART_USERNAME),
})

const missingSettings = (raw: Raw): Setting[] =>
  [
    raw.stalwartUrl ? undefined : STALWART_URL,
    raw.username ? undefined : STALWART_USERNAME,
    raw.password ? undefined : STALWART_PASSWORD,
    raw.transport === 'http' && !raw.authToken ? MCP_AUTH_TOKEN : undefined,
  ].filter((s): s is Setting => s !== undefined)

const invalidSettings = (raw: Raw): string[] => {
  const problems: string[] = []
  if (raw.transport !== 'stdio' && raw.transport !== 'http') {
    problems.push(`  MCP_TRANSPORT (--transport): "${raw.transport}" is not a transport; use stdio or http`)
  }
  if (raw.stalwartUrl && !isHttpUrl(raw.stalwartUrl)) {
    problems.push(`  STALWART_URL (--stalwart-url): "${raw.stalwartUrl}" is not an http(s) URL`)
  }
  if (raw.portRaw !== undefined && parsePort(raw.portRaw) === undefined) {
    problems.push(`  MCP_PORT (--port): "${raw.portRaw}" is not a port number (0–65535)`)
  }
  if (raw.publicUrl && !isHttpUrl(raw.publicUrl)) {
    problems.push(`  MCP_PUBLIC_URL (--public-url): "${raw.publicUrl}" is not an http(s) URL`)
  }
  return problems
}

export const parseSelfHostedConfig = (argv: string[], env: Record<string, string | undefined>): ParseResult => {
  const read = readFlags(argv)
  if ('message' in read) {
    return { message: read.message, ok: false }
  }
  const raw = readRaw(read.flags, env)

  const missing = missingSettings(raw)
  const problems = invalidSettings(raw)
  const sections = [
    ...(missing.length > 0 ? [`Missing settings:\n${missing.map(describe).join('\n')}`] : []),
    ...(problems.length > 0 ? [`Invalid settings:\n${problems.join('\n')}`] : []),
  ]
  const { password, stalwartUrl, username } = raw
  if (sections.length > 0 || !stalwartUrl || !username || !password) {
    return {
      message: `The self-hosted Langmail MCP server cannot start.\n${sections.join('\n')}\n${USAGE}`,
      ok: false,
    }
  }

  const transport: Transport = raw.transport === 'http' ? 'http' : 'stdio'
  // Over stdio with no port set, the ticket listener takes a free one.
  const defaultPort = transport === 'http' ? DEFAULT_HTTP_PORT : undefined
  const port = raw.portRaw === undefined ? defaultPort : parsePort(raw.portRaw)
  return {
    config: {
      ...(raw.authToken ? { authToken: raw.authToken } : {}),
      ...(raw.email ? { email: raw.email } : {}),
      host: raw.host,
      password,
      ...(port === undefined ? {} : { port }),
      ...(raw.publicUrl ? { publicUrl: raw.publicUrl.replace(TRAILING_SLASHES_RE, '') } : {}),
      stalwartUrl: stalwartUrl.replace(TRAILING_SLASHES_RE, ''),
      transport,
      username,
    },
    ok: true,
  }
}

// The Basic header the tools hand to Stalwart (jmap/session.ts passes it
// through bearerAuthorization unchanged).
export const basicAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`

// Where minted attachment and image links point when the operator set no
// public URL: the bound address, with a wildcard bind replaced by loopback
// (a link to 0.0.0.0 opens nowhere).
export const defaultPublicUrl = (host: string, port: number): string => {
  const reachable = host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host
  const bracketed = reachable.includes(':') && !reachable.startsWith('[') ? `[${reachable}]` : reachable
  return `http://${bracketed}:${port}`
}
