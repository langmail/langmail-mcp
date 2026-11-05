// Shared plumbing for the agent-trajectory evals (smoke-agent-*.ts): JMAP
// test ingress (blob upload + Email/import + cleanup) and `claude -p`
// trajectory capture. The evals assert on the OBSERVED TOOL-USE TRAJECTORY
// rather than on the model's self-reported answer — an agent could search
// four times and report once, which is exactly the behaviour these evals
// exist to catch.
//
// Requires:
//   - `claude` CLI on PATH
//   - MCP_ACCESS_TOKEN, STALWART_PUBLIC_URL
//     (deployed: source <(./infra/scripts/obtain-mcp-tokens.sh);
//      local dev account: services/auth `bun run dev:eval-token`)
//   - AGENT_EVAL_MCP_URL to drive a local MCP server (e.g.
//     http://127.0.0.1:8090/mcp); unset, the agent uses `.mcp.json` at the repo
//     root, i.e. the deployed server. See docs/guides/local-development.md
//     § Agent trajectory evals.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const JMAP_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

export const DAY_MS = 86_400_000

export const log = (msg: string) => process.stdout.write(`▶ ${msg}\n`)

// A failed expectation, distinguished from a crash so the handler can print it
// as a clean `✗ message` rather than a stack.
class EvalFailure extends Error {}

// Throws rather than exiting: these evals seed real messages into a real
// mailbox, and they are non-deterministic by nature, so a failing run is the
// expected case. `process.exit` here would skip main's `finally` and leave the
// fixtures behind, so every later run would start dirty.
export const fail = (msg: string): never => {
  throw new EvalFailure(msg)
}

const requireEnv = (name: string): string => {
  const v = process.env[name]
  if (!v) {
    process.stderr.write(`✗ missing required env var ${name}\n`)
    process.exit(2)
  }
  return v
}

const TRAILING_SLASHES_RE = /\/+$/u

// Read at module load, like the pre-split scripts did: an eval without its
// env should die before it seeds anything.
const stalwart = requireEnv('STALWART_PUBLIC_URL').replace(TRAILING_SLASHES_RE, '')
const token = requireEnv('MCP_ACCESS_TOKEN')

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9-]+\.langmail\.test)$/u
const isLocal = (url: string): boolean => {
  try {
    return LOCAL_HOST_RE.test(new URL(url).hostname)
  } catch {
    return false
  }
}

// A local MCP must come with a local Stalwart: a stale deployed
// STALWART_PUBLIC_URL would seed and delete fixtures in a real mailbox while
// the agent talks to the local server. Checked here, before anything is seeded.
const evalMcpUrl = process.env.AGENT_EVAL_MCP_URL
if (evalMcpUrl && !(isLocal(evalMcpUrl) && isLocal(stalwart))) {
  process.stderr.write(
    '✗ with AGENT_EVAL_MCP_URL set, it and STALWART_PUBLIC_URL must be loopback or *.langmail.test ' +
      `(got ${evalMcpUrl}, ${stalwart})\n`
  )
  process.exit(2)
}

// --- JMAP plumbing (test ingress: blob upload + Email/import) ---------------

export interface Session {
  accountId: string
  apiUrl: string
  uploadUrl: string
  // The authenticated principal (RFC 8620 §2). The fixtures are addressed to
  // it, so the seeded mail names the mailbox it actually lands in rather than
  // a guess at who is running the eval.
  username: string
}

// A JMAP response envelope, left deliberately loose: the evals poke at a
// handful of unrelated method results, so each call site narrows the payload
// it asked for rather than modelling every method's shape here.
export interface JmapResponse {
  methodResponses?: [string, Record<string, unknown>, string][]
}

const jmapCall = async (session: Session, methodCalls: unknown[]): Promise<JmapResponse> => {
  const res = await fetch(session.apiUrl, {
    body: JSON.stringify({ methodCalls, using: JMAP_USING }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`JMAP call failed: HTTP ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as JmapResponse
}

export const openSession = async (): Promise<Session> => {
  const res = await fetch(`${stalwart}/.well-known/jmap`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new Error(`jmap session discovery failed: HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    apiUrl?: string
    primaryAccounts?: Record<string, string>
    uploadUrl?: string
    username?: string
  }
  const accountId = body.primaryAccounts?.['urn:ietf:params:jmap:mail']
  if (!(body.apiUrl && body.uploadUrl && body.username && accountId)) {
    throw new Error('jmap session missing apiUrl / uploadUrl / username / mail account')
  }
  return { accountId, apiUrl: body.apiUrl, username: body.username, uploadUrl: body.uploadUrl }
}

export const inboxId = async (session: Session): Promise<string> => {
  const json = await jmapCall(session, [
    ['Mailbox/query', { accountId: session.accountId }, '0'],
    [
      'Mailbox/get',
      {
        '#ids': { name: 'Mailbox/query', path: '/ids', resultOf: '0' },
        accountId: session.accountId,
        properties: ['id', 'role'],
      },
      '1',
    ],
  ])
  const list = json.methodResponses?.[1]?.[1]?.list as { id: string; role?: string }[] | undefined
  const inbox = list?.find((m) => m.role?.toLowerCase() === 'inbox')
  if (!inbox) {
    throw new Error('account has no Inbox mailbox')
  }
  return inbox.id
}

export interface Fixture {
  body: string
  // Defaults to text/plain; the preview eval seeds text/html bodies.
  contentType?: string
  from: string
  receivedAt: Date
  subject: string
  typeKeyword?: string
}

const rfc822 = (f: Fixture, to: string): string =>
  [
    `From: ${f.from}`,
    `To: ${to}`,
    `Subject: ${f.subject}`,
    `Message-ID: <${crypto.randomUUID()}@langmail-eval.example>`,
    `Date: ${f.receivedAt.toUTCString()}`,
    `Content-Type: ${f.contentType ?? 'text/plain'}; charset=utf-8`,
    '',
    f.body,
  ].join('\r\n')

export const seed = async (session: Session, mailboxId: string, to: string, f: Fixture): Promise<string> => {
  const uploadRes = await fetch(
    session.uploadUrl.replace('{accountId}', session.accountId).replace('{type}', 'message/rfc822'),
    {
      body: rfc822(f, to),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'message/rfc822' },
      method: 'POST',
    }
  )
  if (!uploadRes.ok) {
    throw new Error(`blob upload failed: HTTP ${uploadRes.status}`)
  }
  const { blobId } = (await uploadRes.json()) as { blobId: string }

  const imported = await jmapCall(session, [
    [
      'Email/import',
      {
        accountId: session.accountId,
        emails: {
          i0: {
            blobId,
            keywords: { $seen: true, ...(f.typeKeyword ? { [f.typeKeyword]: true } : {}) },
            mailboxIds: { [mailboxId]: true },
            receivedAt: f.receivedAt.toISOString(),
          },
        },
      },
      '0',
    ],
  ])
  const created = imported.methodResponses?.[0]?.[1]?.created as Record<string, { id?: string }> | undefined
  const id = created?.i0?.id
  if (!id) {
    throw new Error(`Email/import failed: ${JSON.stringify(imported.methodResponses?.[0])}`)
  }
  return id
}

export const destroy = async (session: Session, ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return
  }
  await jmapCall(session, [['Email/set', { accountId: session.accountId, destroy: ids }, '0']])
}

// --- trajectory capture -----------------------------------------------------

export interface ToolUse {
  input: Record<string, unknown>
  name: string
}

export interface Trajectory {
  resultText: string
  toolUses: ToolUse[]
}

// One line of `--output-format stream-json`, narrowed to the two things the
// evals read: the content blocks of a message, and the final result string.
interface StreamBlock {
  content?: unknown
  input?: Record<string, unknown>
  name?: string
  type?: string
}

interface StreamEvent {
  message?: { content?: StreamBlock[] }
  result?: string
}

const parseEvent = (line: string): StreamEvent | null => {
  try {
    return JSON.parse(line) as StreamEvent
  } catch {
    return null
  }
}

// `claude -p --output-format stream-json` emits one JSON object per line:
// assistant messages carry `tool_use` content blocks, user messages carry the
// matching `tool_result`. Both are needed — the calls prove the strategy, the
// results prove it actually retrieved the target.
const collectBlock = (block: StreamBlock, into: Trajectory): void => {
  if (block.type === 'tool_use') {
    into.toolUses.push({ input: block.input ?? {}, name: block.name ?? '' })
  }
  if (block.type === 'tool_result') {
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    into.resultText += `${text}\n`
  }
}

const parseTrajectory = (stdout: string): Trajectory => {
  const trajectory: Trajectory = { resultText: '', toolUses: [] }
  for (const line of stdout.split('\n')) {
    const event = line.trim() ? parseEvent(line) : null
    if (!event) {
      continue
    }
    for (const block of event.message?.content ?? []) {
      collectBlock(block, trajectory)
    }
    if (typeof event.result === 'string') {
      trajectory.resultText += `${event.result}\n`
    }
  }
  return trajectory
}

// Langmail tool calls of the last runAgent, for runEval's verdict line: two
// runs (main vs a branch) compare on right-or-wrong AND on how many calls it
// took. Harness calls such as ToolSearch are not counted.
let lastToolCalls: number | null = null
const LANGMAIL_TOOL = 'mcp__langmail__'

// The MCP config for `claude -p`. With AGENT_EVAL_MCP_URL a temporary config
// names that server `langmail` (so the tools stay `mcp__langmail__*`) and sends
// the eval's own bearer; otherwise the repo's `.mcp.json` (deployed server).
const mcpConfig = (): { cleanup: () => void; path: string } => {
  const url = evalMcpUrl
  if (!url) {
    return { cleanup: () => undefined, path: '.mcp.json' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-mcp-'))
  const path = join(dir, 'mcp.json')
  const servers = { langmail: { headers: { Authorization: `Bearer ${token}` }, type: 'http', url } }
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), path }
}

export const runAgent = (prompt: string): Trajectory => {
  const config = mcpConfig()
  try {
    const proc = Bun.spawnSync(
      [
        'claude',
        '-p',
        prompt,
        '--mcp-config',
        config.path,
        // Only the servers in that config: a claude.ai Langmail connector in
        // the operator's session would otherwise reach their real mailbox.
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__langmail__*',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      {
        cwd: new URL('../../..', import.meta.url).pathname,
        // Belt and braces with --strict-mcp-config: no claude.ai connectors.
        env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        stderr: 'inherit',
      }
    )
    if (proc.exitCode !== 0) {
      throw new Error(`claude exited ${proc.exitCode}`)
    }
    const trajectory = parseTrajectory(proc.stdout.toString())
    const foreign = trajectory.toolUses.filter((t) => t.name.startsWith('mcp__') && !t.name.startsWith(LANGMAIL_TOOL))
    if (foreign.length > 0) {
      throw new Error(`the agent reached an MCP server other than the eval's: ${foreign.map((t) => t.name).join(', ')}`)
    }
    lastToolCalls = trajectory.toolUses.filter((t) => t.name.startsWith(LANGMAIL_TOOL)).length
    return trajectory
  } finally {
    config.cleanup()
  }
}

const verdictSuffix = (): string => (lastToolCalls === null ? '' : ` · tool calls: ${lastToolCalls}`)

// Uniform exit handling: a failed expectation is the eval's own verdict and
// reads better as one line; anything else is a genuine crash and keeps its
// stack. Either way the exit happens here, after main's `finally` has removed
// the fixtures.
export const runEval = async (main: () => Promise<void>): Promise<void> => {
  try {
    await main()
    process.stdout.write(`result: pass${verdictSuffix()}\n`)
  } catch (error) {
    if (error instanceof EvalFailure) {
      process.stderr.write(`✗ ${error.message}\n`)
      process.stdout.write(`result: fail${verdictSuffix()}\n`)
    } else {
      process.stderr.write(`✗ ${error instanceof Error ? error.stack : String(error)}\n`)
      process.stdout.write(`result: error${verdictSuffix()}\n`)
    }
    process.exit(1)
  }
}
