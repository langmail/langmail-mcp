// Checks the langmail-mcp npm package the way someone installs it:
// `bun run check:package [--runtime node|bun]` (node by default; CI runs it
// in .github/workflows/release.yml).
//
// 1. `npm pack` (whose prepack builds dist/) and `npm install` of the tarball
//    into an empty project in a temporary directory: no workspace, no
//    @langmail/* package, only what npm installs from the package's
//    dependencies.
// 2. `langmail-mcp --help` lists every setting.
// 3. The bin, started by `npx` (Node) or `bunx --bun` (Bun) against a fake
//    Stalwart, serves tools over stdio and over Streamable HTTP: initialize,
//    tools/list, a search_emails call and the email viewer resource, built
//    when the package was built. Over stdio, stdout must carry nothing but the
//    protocol.

import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { startFakeStalwart } from '../src/test-support/fake-stalwart.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const USERNAME = 'alice'
const PASSWORD = 'app-pass'
const MCP_TOKEN = 'check-package-secret'
const VIEWER_URI = 'ui://langmail/email-viewer'
const HELP_VARIABLES = [
  'STALWART_URL',
  'STALWART_USERNAME',
  'STALWART_PASSWORD',
  'STALWART_EMAIL',
  'MCP_TRANSPORT',
  'MCP_HOST',
  'MCP_PORT',
  'MCP_PUBLIC_URL',
  'MCP_AUTH_TOKEN',
  'LOG_LEVEL',
  'NODE_ENV',
  'BETTERSTACK_SOURCE_TOKEN',
  'BETTERSTACK_ENDPOINT',
  'BETTERSTACK_ERRORS_DSN',
]
const LISTEN_URL_RE = /"listenUrl":"(http:\/\/[^"]+)"/u

const { values } = parseArgs({ options: { runtime: { default: 'node', type: 'string' } } })
const runtime = values.runtime
if (runtime !== 'node' && runtime !== 'bun') {
  throw new Error(`--runtime is node or bun, not ${runtime}`)
}

const check = (ok: unknown, what: string): void => {
  if (!ok) {
    throw new Error(`check failed: ${what}`)
  }
  process.stdout.write(`ok - ${what}\n`)
}

const run = (command: string, args: string[], cwd: string): string => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

// How someone starts the installed bin: npx under Node, bunx --bun under Bun
// (without --bun, bunx follows the bin's node shebang).
const binCommand = (args: string[]): { args: string[]; command: string } =>
  runtime === 'node'
    ? { args: ['--no-install', 'langmail-mcp', ...args], command: 'npx' }
    : { args: ['--bun', 'langmail-mcp', ...args], command: 'bunx' }

// A clean environment: nothing from the repository's shell leaks in.
const baseEnv = (): Record<string, string> => ({
  HOME: process.env.HOME ?? tmpdir(),
  LOG_LEVEL: 'info',
  PATH: process.env.PATH ?? '',
})

const work = await mkdtemp(path.join(tmpdir(), 'langmail-mcp-check-'))
const project = path.join(work, 'project')
const stalwart = await startFakeStalwart({ password: PASSWORD, username: USERNAME })

try {
  // --- 1. pack and install -------------------------------------------------
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], ROOT)) as {
    files: { path: string }[]
    filename: string
    name: string
    version: string
  }[]
  check(packed?.name === 'langmail-mcp', `npm pack names the package langmail-mcp (${packed?.name})`)
  check(packed?.version === pkg.version, `the tarball is version ${pkg.version}`)
  check(
    packed?.files.some((f) => f.path === 'dist/langmail-mcp.js'),
    'the tarball carries the bin dist/langmail-mcp.js'
  )
  check(!packed?.files.some((f) => f.path.startsWith('src/')), 'the tarball carries no source')

  await rm(project, { force: true, recursive: true })
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), '{ "name": "check", "private": true }\n')
  run('npm', ['install', '--no-audit', '--no-fund', path.join(work, packed?.filename ?? '')], project)
  const scoped: string[] = await readdir(path.join(project, 'node_modules')).catch(() => [])
  check(!scoped.includes('@langmail'), 'installing it brings in no @langmail/* package')

  // --- 2. --help -----------------------------------------------------------
  const help = binCommand(['--help'])
  const helpText = run(help.command, help.args, project)
  check(
    HELP_VARIABLES.every((v) => helpText.includes(`  ${v}`)),
    `${runtime}: --help lists every setting with its environment variable`
  )

  const settings = {
    STALWART_PASSWORD: PASSWORD,
    STALWART_URL: stalwart.url,
    STALWART_USERNAME: USERNAME,
  }

  const exercise = async (client: Client, transport: string): Promise<void> => {
    check(
      client.getServerVersion()?.version === pkg.version,
      `${runtime}/${transport}: serverInfo.version is ${pkg.version}`
    )
    const { tools } = await client.listTools()
    const names = new Set(tools.map((t) => t.name))
    check(names.has('search_emails') && names.has('get_email'), `${runtime}/${transport}: lists the mail tools`)
    check(!names.has('share_calendar'), `${runtime}/${transport}: leaves out the hosted-only sharing tools`)
    stalwart.jmapCalls.length = 0
    const search = await client.callTool({ arguments: { todo: true }, name: 'search_emails' })
    check(
      !search.isError && stalwart.jmapCalls.some((c) => c.name === 'Email/query'),
      `${runtime}/${transport}: search_emails reaches Stalwart`
    )
    const viewer = await client.readResource({ uri: VIEWER_URI })
    const html = viewer.contents[0] && 'text' in viewer.contents[0] ? viewer.contents[0].text : ''
    check(
      html.startsWith('<!doctype html>') && html.includes('<script type="module">'),
      `${runtime}/${transport}: serves the email viewer`
    )
  }

  // --- 3a. stdio -----------------------------------------------------------
  {
    const bin = binCommand([])
    const transport = new StdioClientTransport({
      args: bin.args,
      command: bin.command,
      cwd: project,
      env: { ...baseEnv(), ...settings },
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const errors: Error[] = []
    const client = new Client({ name: 'check-package', version: '0' })
    client.onerror = (error) => errors.push(error)
    try {
      await client.connect(transport)
      await exercise(client, 'stdio')
      check(errors.length === 0, `${runtime}/stdio: stdout carries only the protocol`)
      check(stderr.includes('self-hosted mcp ready'), `${runtime}/stdio: logs go to stderr`)
    } catch (error) {
      process.stderr.write(stderr)
      throw error
    } finally {
      await client.close()
    }
  }

  // --- 3b. Streamable HTTP --------------------------------------------------
  {
    const bin = binCommand(['--transport', 'http', '--port', '0'])
    const child = spawn(bin.command, bin.args, {
      cwd: project,
      // Its own process group: npx runs the server as a child of its own,
      // and killing npx alone leaves the server running.
      detached: true,
      env: { ...baseEnv(), ...settings, MCP_AUTH_TOKEN: MCP_TOKEN },
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    let stderr = ''
    const listenUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listener within 30s:\n${stderr}`)), 30_000)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        const found = LISTEN_URL_RE.exec(stderr)?.[1]
        if (found) {
          clearTimeout(timer)
          resolve(found)
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`exited with ${code} before listening:\n${stderr}`))
      })
    })
    const unauthorized = await fetch(`${listenUrl}/mcp`, { body: '{}', method: 'POST' })
    check(unauthorized.status === 401, `${runtime}/http: /mcp without the bearer answers 401`)
    const client = new Client({ name: 'check-package', version: '0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${listenUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
        })
      )
      await exercise(client, 'http')
    } catch (error) {
      process.stderr.write(stderr)
      throw error
    } finally {
      await client.close()
      if (child.pid) {
        process.kill(-child.pid, 'SIGTERM')
      }
    }
  }
  process.stdout.write(`langmail-mcp ${pkg.version} packs, installs and runs under ${runtime}\n`)
} finally {
  await stalwart.stop()
  await rm(work, { force: true, recursive: true })
}
