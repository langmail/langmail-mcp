// Agent-retrieval eval for the email-type filter (ADR 0010). Seeds a mailbox
// with a known fixture set, drives the deployed MCP server through `claude -p`
// with the session's own request — "show me the cinema tickets of yesterday's
// show" — and asserts on the OBSERVED TOOL-USE TRAJECTORY rather than on the
// model's self-reported answer. scripts/smoke-agent.sh asserts over structured
// output, which cannot prove call counts: an agent could search four times and
// report once, which is exactly the behaviour this feature exists to remove.
//
// The fixtures make both halves of the guidance load-bearing:
//
//   - the target booking confirmation carries `$type:ticket`, arrives two days
//     before "today", and is for a show that ran yesterday — so it sits
//     OUTSIDE a literal "yesterday" received-date window. Finding it requires
//     widening the window by a booking lead time, which the after/before
//     descriptions tell the model to do.
//   - a second, older `$type:ticket` message (a different show, six weeks
//     back) means a bare keyword filter with no date window cannot pass by
//     accident.
//   - two newsletters whose bodies say "Kinotickets" mean a free-text query
//     lands on noise, which is what made the original session fail.
//
// Everything seeded is deleted again on exit, so re-runs stay clean.
//
// Slow + non-deterministic; runs only via `just smoke-test-mcp-agent-type`.
// Not part of `just deploy`.
//
// Requires:
//   - `claude` CLI on PATH
//   - `.mcp.json` at the repo root
//   - MCP_ACCESS_TOKEN, STALWART_PUBLIC_URL
//     (source <(./infra/scripts/obtain-mcp-tokens.sh))

const JMAP_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']
const SEARCH_TOOL = 'mcp__langmail__search_emails'
const DAY_MS = 86_400_000

const log = (msg: string) => process.stdout.write(`▶ ${msg}\n`)

// A failed expectation, distinguished from a crash so the handler can print it
// as a clean `✗ message` rather than a stack.
class EvalFailure extends Error {}

// Throws rather than exiting: this eval seeds real messages into a real
// mailbox, and it is non-deterministic by nature, so a failing run is the
// expected case. `process.exit` here would skip main's `finally` and leave the
// fixtures behind, so every later run would start dirty.
const fail = (msg: string): never => {
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

const stalwart = requireEnv('STALWART_PUBLIC_URL').replace(/\/+$/u, '')
const token = requireEnv('MCP_ACCESS_TOKEN')

// --- JMAP plumbing (test ingress: blob upload + Email/import) ---------------

interface Session {
  accountId: string
  apiUrl: string
  uploadUrl: string
}

// A JMAP response envelope, left deliberately loose: this script pokes at a
// handful of unrelated method results, so each call site narrows the payload it
// asked for rather than modelling every method's shape here.
interface JmapResponse {
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

const openSession = async (): Promise<Session> => {
  const res = await fetch(`${stalwart}/.well-known/jmap`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new Error(`jmap session discovery failed: HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    apiUrl?: string
    primaryAccounts?: Record<string, string>
    uploadUrl?: string
  }
  const accountId = body.primaryAccounts?.['urn:ietf:params:jmap:mail']
  if (!(body.apiUrl && body.uploadUrl && accountId)) {
    throw new Error('jmap session missing apiUrl / uploadUrl / mail account')
  }
  return { accountId, apiUrl: body.apiUrl, uploadUrl: body.uploadUrl }
}

const inboxId = async (session: Session): Promise<string> => {
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

interface Fixture {
  body: string
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
    'Content-Type: text/plain; charset=utf-8',
    '',
    f.body,
  ].join('\r\n')

const seed = async (session: Session, mailboxId: string, to: string, f: Fixture): Promise<string> => {
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

const destroy = async (session: Session, ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return
  }
  await jmapCall(session, [['Email/set', { accountId: session.accountId, destroy: ids }, '0']])
}

// --- trajectory capture -----------------------------------------------------

interface ToolUse {
  input: Record<string, unknown>
  name: string
}

interface Trajectory {
  resultText: string
  toolUses: ToolUse[]
}

// One line of `--output-format stream-json`, narrowed to the two things this
// eval reads: the content blocks of a message, and the final result string.
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

const runAgent = (prompt: string): Trajectory => {
  const proc = Bun.spawnSync(
    [
      'claude',
      '-p',
      prompt,
      '--mcp-config',
      '.mcp.json',
      '--allowedTools',
      'mcp__langmail__*',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    { cwd: new URL('../../..', import.meta.url).pathname, stderr: 'inherit' }
  )
  if (proc.exitCode !== 0) {
    throw new Error(`claude exited ${proc.exitCode}`)
  }
  return parseTrajectory(proc.stdout.toString())
}

// --- the scenario -----------------------------------------------------------

const main = async () => {
  const session = await openSession()
  const mailboxId = await inboxId(session)
  // The account's own address, as the MCP principal reports it — the fixtures
  // are addressed to whoever is running the eval.
  const to = process.env.MCP_PRINCIPAL ?? 'eval@langmail.me'

  const now = new Date()
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS)
  const targetReceivedAt = daysAgo(2)

  const fixtures: Record<string, Fixture> = {
    // The target: booked two days out, for a show that ran yesterday. Nothing
    // in the subject says "ticket" or "cinema" — that is the whole point.
    target: {
      body: 'Your seats are reserved. Row 7, seats 12-13. Please arrive ten minutes early.',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      receivedAt: targetReceivedAt,
      subject: 'Booking for Signals from Saturn',
      typeKeyword: '$type:ticket',
    },
    // Same type, wrong date: a bare keyword filter would return this too.
    olderTicket: {
      body: 'Your seats are reserved. Row 2, seat 4.',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      receivedAt: daysAgo(44),
      subject: 'Booking for The Long Quiet',
      typeKeyword: '$type:ticket',
    },
    // Keyword bait: the word a free-text query would reach for.
    baitOne: {
      body: 'Kinotickets zum halben Preis, nur diese Woche! Jetzt sichern.',
      from: 'Wochenpost <newsletter@wochenpost.example>',
      receivedAt: daysAgo(1),
      subject: 'Diese Woche im Kino',
      typeKeyword: '$type:newsletter',
    },
    baitTwo: {
      body: 'Alle Kinotickets im Abo — unser Angebot für Vielseher.',
      from: 'Filmclub <news@filmclub.example>',
      receivedAt: daysAgo(3),
      subject: 'Der Filmclub-Newsletter',
      typeKeyword: '$type:newsletter',
    },
  }

  const seeded: Record<string, string> = {}
  try {
    log('seed fixtures')
    for (const [key, fixture] of Object.entries(fixtures)) {
      seeded[key] = await seed(session, mailboxId, to, fixture)
    }
    process.stdout.write(`  target=${seeded.target} older=${seeded.olderTicket}\n`)

    // Stalwart indexes asynchronously; give the imports a moment to land.
    await Bun.sleep(2000)

    log('run the agent')
    const yesterday = daysAgo(1).toISOString().slice(0, 10)
    const { resultText, toolUses } = runAgent(
      `Show me the cinema tickets of yesterday's show (the showing was on ${yesterday}). ` +
        'Tell me the exact subject of the booking confirmation and its message id.'
    )

    const searches = toolUses.filter((t) => t.name === SEARCH_TOOL)
    process.stdout.write(`  tools called: ${toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    for (const s of searches) {
      process.stdout.write(`  search_emails ${JSON.stringify(s.input)}\n`)
    }

    // 1. One call, not a sequence of speculative keyword searches.
    if (searches.length !== 1) {
      fail(`expected exactly 1 search_emails call, saw ${searches.length}`)
    }
    const [search] = searches
    const input = search?.input ?? {}

    // 2. It filtered by type rather than guessing at words.
    const keywords = Array.isArray(input.keywords) ? (input.keywords as string[]) : []
    if (!keywords.includes('ticket')) {
      fail(`search_emails did not filter on the ticket type: ${JSON.stringify(input)}`)
    }

    // 3. The window is wide enough for a booking lead time — the target's
    //    received date is two days before the show, so a literal "yesterday"
    //    window misses it.
    const after = typeof input.after === 'string' ? Date.parse(input.after) : Number.NaN
    const before = typeof input.before === 'string' ? Date.parse(input.before) : Number.NaN
    if (Number.isNaN(after) || Number.isNaN(before)) {
      fail(`search_emails did not bound the search with after/before: ${JSON.stringify(input)}`)
    }
    const receivedAt = targetReceivedAt.getTime()
    if (!(after <= receivedAt && receivedAt < before)) {
      fail(
        `the after/before window [${input.after}, ${input.before}) does not contain the booking's ` +
          `received date ${targetReceivedAt.toISOString()} — the lead-time guidance did not land`
      )
    }

    // 4. It actually retrieved the target, and the window did its job: the
    //    six-week-old ticket stayed out.
    if (!resultText.includes(seeded.target ?? '')) {
      fail('the seeded booking was not among the returned hits')
    }
    if (resultText.includes(seeded.olderTicket ?? '')) {
      fail('the older ticket was returned too — the date window was not load-bearing')
    }

    process.stdout.write('\n✅ type-filter agent eval passed\n')
  } finally {
    log('clean up seeded fixtures')
    await destroy(session, Object.values(seeded))
  }
}

try {
  await main()
} catch (error) {
  // A failed expectation is the eval's own verdict and reads better as one
  // line; anything else is a genuine crash and keeps its stack. Either way the
  // exit happens here, after main's `finally` has removed the fixtures.
  if (error instanceof EvalFailure) {
    process.stderr.write(`✗ ${error.message}\n`)
  } else {
    process.stderr.write(`✗ ${error instanceof Error ? error.stack : String(error)}\n`)
  }
  process.exit(1)
}
