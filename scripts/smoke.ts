// Phase 3a deterministic smoke. Drives the deployed MCP server as a
// real client and asserts:
//
//   1. `search_emails` is registered.
//   2. A self-loop message tagged `smoke-<ts>-<pid>` (delivered by
//      smoke-test-mail.sh on every `just deploy` run) round-trips
//      through Stalwart FTS into our tool.
//   3. Bad input (empty query, oversized limit, unknown mailbox)
//      produces a clean tool error, not a thrown exception.
//   4. Refreshing the access token via /auth/token produces a new
//      bearer that still authenticates against /mcp.
//
// OAuth dance is out-of-band on purpose. Run
// `infra/scripts/obtain-mcp-tokens.sh` first (or any equivalent) to
// pre-populate:
//   MCP_ACCESS_TOKEN, MCP_REFRESH_TOKEN, MCP_OAUTH_CLIENT_ID,
//   MCP_PUBLIC_URL, STALWART_PUBLIC_URL
//
// Run via `bun run smoke` from services/mcp/, or as part of
// `just smoke-test-mcp`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TRAILING_SLASHES_RE = /\/+$/u
const SINGLE_MATCH_RE = /^1 message\(s\) matched/mu
const FIRST_ID_RE = /^\s*id:\s*(\S+)/mu
// The smoke message's attachment as get_email lists it (human size varies
// with the exact PDF bytes, so only name/type/blobId are pinned).
const SMOKE_PDF_LINE_RE = /^\d+\. smoke\.pdf — application\/pdf, \S+ [KM]?B — blobId: (\S+)$/mu
const DOWNLOAD_URL_RE = /^(https?:\/\/\S+\/attachments\/\S+)$/mu
// A base64 run this long in a tool result means attachment bytes leaked
// into the conversation — the thing the capability-URL design forbids.
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{100,}/u

// Wide sentinel dates that bracket any real smoke message (delivered "now").
// A message received today is after EPOCH_PAST and before EPOCH_FUTURE.
const EPOCH_PAST = '2020-01-01T00:00:00Z'
const EPOCH_FUTURE = '2100-01-01T00:00:00Z'

// The category keyword the smoke run stamps onto its message so the
// keyword-filter path can be exercised end-to-end. Maps to the `receipt`
// enum value on search_emails.
const SMOKE_LABEL = '$label:receipt'
const JMAP_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

const log = (msg: string) => process.stdout.write(`▶ ${msg}\n`)

const requireEnv = (name: string): string => {
  const v = process.env[name]
  if (!v) {
    process.stderr.write(`✗ missing required env var ${name}\n`)
    process.exit(2)
  }
  return v
}

const fail = (msg: string): never => {
  process.stderr.write(`✗ ${msg}\n`)
  process.exit(1)
}

const unwrapText = (result: {
  content?: { type?: string; text?: string }[]
  isError?: boolean
}): { text: string; isError: boolean } => {
  const first = result.content?.[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`tool response missing content[0].text: ${JSON.stringify(result)}`)
  }
  return { isError: Boolean(result.isError), text: first.text }
}

const connect = async (mcpUrl: string, token: string): Promise<{ client: Client; close: () => Promise<void> }> => {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'langmail-mcp-smoke', version: '0.1.0' })
  await client.connect(transport)
  return {
    client,
    close: async () => {
      await client.close()
      try {
        await transport.close()
      } catch {
        // ignore
      }
    },
  }
}

const exchangeRefresh = async (opts: {
  stalwartUrl: string
  clientId: string
  refreshToken: string
}): Promise<{ access_token: string; refresh_token?: string }> => {
  const res = await fetch(`${opts.stalwartUrl}/auth/token`, {
    body: new URLSearchParams({
      client_id: opts.clientId,
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
    }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`refresh exchange failed: HTTP ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as { access_token: string; refresh_token?: string }
}

const firstId = (text: string): string | null => FIRST_ID_RE.exec(text)?.[1] ?? null

// Resolve the JMAP api URL + mail account id from the discovery doc, using the
// same bearer the MCP tools forward. Needed to stamp a keyword onto the smoke
// message (JMAP has no MCP write tool by design).
const jmapSession = async (stalwartUrl: string, token: string): Promise<{ accountId: string; apiUrl: string }> => {
  const res = await fetch(`${stalwartUrl}/.well-known/jmap`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`jmap session discovery failed: HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    apiUrl?: string
    primaryAccounts?: Record<string, string>
  }
  const accountId = body.primaryAccounts?.['urn:ietf:params:jmap:mail']
  if (!(body.apiUrl && accountId)) {
    throw new Error('jmap session missing apiUrl / mail account')
  }
  return { accountId, apiUrl: body.apiUrl }
}

// Stamp a keyword onto a message via Email/set (patch form). Idempotent: a
// re-run just re-sets the same keyword true.
const setKeyword = async (opts: {
  accountId: string
  apiUrl: string
  emailId: string
  keyword: string
  token: string
}): Promise<void> => {
  const res = await fetch(opts.apiUrl, {
    body: JSON.stringify({
      methodCalls: [
        [
          'Email/set',
          {
            accountId: opts.accountId,
            update: { [opts.emailId]: { [`keywords/${opts.keyword}`]: true } },
          },
          '0',
        ],
      ],
      using: JMAP_USING,
    }),
    headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`Email/set failed: HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    methodResponses?: [string, { notUpdated?: Record<string, unknown> }, string][]
  }
  const notUpdated = json.methodResponses?.[0]?.[1]?.notUpdated
  if (notUpdated && Object.keys(notUpdated).length > 0) {
    throw new Error(`Email/set did not update ${opts.emailId}: ${JSON.stringify(notUpdated)}`)
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: integration smoke test is inherently sequential
const main = async () => {
  const mcpBase = requireEnv('MCP_PUBLIC_URL').replace(TRAILING_SLASHES_RE, '')
  const stalwart = requireEnv('STALWART_PUBLIC_URL').replace(TRAILING_SLASHES_RE, '')
  const clientId = requireEnv('MCP_OAUTH_CLIENT_ID')
  const accessToken = requireEnv('MCP_ACCESS_TOKEN')
  const refreshToken = process.env.MCP_REFRESH_TOKEN ?? ''
  const smokeTag = process.env.MCP_SMOKE_TAG ?? ''
  const mcpUrl = `${mcpBase}/mcp`

  let passed = 0
  const pass = (msg: string) => {
    process.stdout.write(`✓ ${msg}\n`)
    passed += 1
  }

  log(`connect to ${mcpUrl}`)
  let session = await connect(mcpUrl, accessToken)

  // Thin wrapper: call a tool by name and unwrap its text result.
  const callText = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> =>
    unwrapText(
      (await session.client.callTool({ arguments: args, name })) as {
        content?: { type?: string; text?: string }[]
        isError?: boolean
      }
    )

  // --- 1. listTools includes search_emails + the new read tools --------
  log('listTools')
  const tools = await session.client.listTools()
  const names = tools.tools.map((t) => t.name)
  const requiredTools = [
    'search_emails',
    'get_email',
    'get_thread',
    'download_attachment',
    'preview_mail_rule',
    'create_mail_rule',
    'list_mail_rules',
    'update_mail_rule',
    'delete_mail_rule',
    'search_contacts',
  ]
  for (const required of requiredTools) {
    if (!names.includes(required)) {
      fail(`${required} missing from tool list: ${names.join(', ')}`)
    }
  }
  pass(`${requiredTools.join(', ')} registered (alongside: ${names.join(', ') || '—'})`)

  // --- 2. Round-trip via the smoke tag ---------------------------------
  //
  // Stalwart's FTS indexes asynchronously: a freshly-delivered message
  // (the mail smoke runs immediately before us) won't always be visible
  // on the first query. Retry a few times with a short backoff before
  // calling it broken.
  if (smokeTag) {
    log(`call search_emails query="${smokeTag}" (with FTS-index retry)`)
    let text = ''
    let isError = false
    let attempts = 0
    const maxAttempts = 6
    for (; attempts < maxAttempts; attempts += 1) {
      const result = await session.client.callTool({
        arguments: { limit: 5, query: smokeTag },
        name: 'search_emails',
      })
      ;({ text, isError } = unwrapText(
        result as {
          content?: { type?: string; text?: string }[]
          isError?: boolean
        }
      ))
      if (!isError && text.includes(smokeTag)) {
        break
      }
      await Bun.sleep(500)
    }
    if (isError) {
      fail(`smoke-tag query returned isError=true: ${text}`)
    }
    if (!text.includes(smokeTag)) {
      fail(`smoke-tag '${smokeTag}' not found after ${maxAttempts} attempts: ${text}`)
    }
    // Tighten: exactly one hit, with the right sender. The tool formats
    // hits as "N message(s) matched:\n\n1. <subject>\n   from: ...\n   date: ...".
    if (!SINGLE_MATCH_RE.test(text)) {
      fail(`expected exactly one hit for unique tag; got: ${text}`)
    }
    if (!text.includes('smoketest@langmail.me')) {
      fail(`hit's sender is not smoketest@langmail.me: ${text}`)
    }
    pass(`smoke-tag round-trip (mail-side delivery → FTS → JMAP → MCP tool, ${attempts + 1} attempt(s))`)

    // The lightweight hit carries the message id; every downstream tool needs
    // it. Throw (not fail) so TS narrows messageId to string — the top-level
    // catch reports and exits 1 just like fail().
    const messageId = firstId(text)
    if (!messageId) {
      throw new Error(`could not parse a message id from search_emails output: ${text}`)
    }

    // --- 2a. Date-range filter includes the just-delivered message ------
    log('call search_emails with an after/before window + tag')
    const dated = await callText('search_emails', {
      after: EPOCH_PAST,
      before: EPOCH_FUTURE,
      limit: 5,
      query: smokeTag,
    })
    if (dated.isError || !dated.text.includes(smokeTag)) {
      fail(`date-filtered search did not find the smoke message: ${dated.text}`)
    }
    pass('date-filtered search (after/before) finds the smoke message')

    // --- 2b. Date-range filter excludes when the window is in the past --
    log('call search_emails with before=past (must exclude a message delivered now)')
    const excluded = await callText('search_emails', { before: EPOCH_PAST, limit: 5, query: smokeTag })
    if (excluded.isError) {
      fail(`before=past search errored: ${excluded.text}`)
    }
    if (excluded.text.includes(smokeTag)) {
      fail(`before=past should have excluded a message delivered now: ${excluded.text}`)
    }
    pass('date filter correctly excludes a message outside the window')

    // --- 2c. get_email returns the message body -------------------------
    log(`call get_email id=${messageId}`)
    const email = await callText('get_email', { id: messageId })
    if (email.isError) {
      fail(`get_email returned isError=true: ${email.text}`)
    }
    // The mail smoke's self-loop body is the single word "ping".
    if (!email.text.toLowerCase().includes('ping')) {
      fail(`get_email did not return the smoke message body ('ping'): ${email.text}`)
    }
    pass('get_email returns the message body')

    // --- 2d. get_thread lists the message's thread ----------------------
    log(`call get_thread id=${messageId}`)
    const thread = await callText('get_thread', { id: messageId })
    if (thread.isError) {
      fail(`get_thread returned isError=true: ${thread.text}`)
    }
    if (!thread.text.includes(messageId)) {
      fail(`get_thread did not include the requested message id ${messageId}: ${thread.text}`)
    }
    pass('get_thread lists the message thread')

    // --- 2e. Attachments: search-hit metadata → capability-URL download --
    log('attachment metadata on the search hit')
    const searchHitBlobId = SMOKE_PDF_LINE_RE.exec(text)?.[1]
    if (!searchHitBlobId) {
      fail(
        'search hit for the smoke message lacks smoke.pdf attachment metadata (a stale /tmp/langmail-smoke-tag from a ' +
          `pre-attachment deploy looks exactly like this — re-run smoke-test-mail.sh first): ${text}`
      )
    }
    pass('search hit shows smoke.pdf attachment metadata with blobId')

    log('get_email lists smoke.pdf with type/size/blobId')
    const pdfLine = SMOKE_PDF_LINE_RE.exec(email.text)
    const blobId = pdfLine?.[1]
    if (!blobId) {
      throw new Error(`get_email did not list smoke.pdf with a blobId: ${email.text}`)
    }
    if (searchHitBlobId !== blobId) {
      fail(`search hit blobId ${searchHitBlobId} did not match get_email blobId ${blobId}`)
    }
    pass('get_email lists smoke.pdf with type/size/blobId')

    log(`call download_attachment blobId=${blobId}`)
    const download = await callText('download_attachment', { blobId, emailId: messageId })
    if (download.isError) {
      fail(`download_attachment returned isError=true: ${download.text}`)
    }
    // Never echo download.text/URLs into failure output from here on — a
    // failing CI run must not persist a live capability URL in its logs.
    if (BASE64_RUN_RE.test(download.text)) {
      fail('download_attachment result carries a base64 payload instead of a URL')
    }
    const downloadUrl = DOWNLOAD_URL_RE.exec(download.text)?.[1]
    if (!downloadUrl) {
      throw new Error('download_attachment did not return a download URL')
    }
    const blobRes = await fetch(downloadUrl)
    if (blobRes.status !== 200) {
      fail(`capability URL GET returned HTTP ${blobRes.status}`)
    }
    if (blobRes.headers.get('content-type') !== 'application/pdf') {
      fail(`capability URL served content-type ${blobRes.headers.get('content-type')}, want application/pdf`)
    }
    const blobBytes = new Uint8Array(await blobRes.arrayBuffer())
    if (!new TextDecoder().decode(blobBytes.slice(0, 5)).startsWith('%PDF')) {
      fail('downloaded blob does not start with the %PDF magic')
    }
    const declaredLength = blobRes.headers.get('content-length')
    if (declaredLength && Number(declaredLength) !== blobBytes.byteLength) {
      fail(`content-length ${declaredLength} does not match downloaded ${blobBytes.byteLength} bytes`)
    }
    pass(`capability URL streams the PDF (${blobBytes.byteLength} bytes, %PDF magic)`)

    log('tampered token must 404')
    const flipped = downloadUrl.slice(0, -1) + (downloadUrl.endsWith('A') ? 'B' : 'A')
    const tampered = await fetch(flipped)
    if (tampered.status !== 404) {
      fail(`tampered capability URL returned HTTP ${tampered.status}, want 404`)
    }
    pass('tampered capability token → 404')

    // --- 2f. Keyword filter (stamp a label via JMAP, then search) -------
    //
    // The category keywords are Postgres-only today (the agent never echoes
    // them to Stalwart), so no message carries one out of the box. Stamp one
    // directly via Email/set to exercise the keyword-filter path end-to-end.
    log(`stamp ${SMOKE_LABEL} onto the smoke message and search keywords=["receipt"]`)
    const js = await jmapSession(stalwart, accessToken)
    await setKeyword({
      accountId: js.accountId,
      apiUrl: js.apiUrl,
      emailId: messageId,
      keyword: SMOKE_LABEL,
      token: accessToken,
    })
    let kwText = ''
    let kwErr = false
    for (let i = 0; i < 4; i += 1) {
      ;({ text: kwText, isError: kwErr } = await callText('search_emails', {
        keywords: ['receipt'],
        limit: 5,
        query: smokeTag,
      }))
      if (!kwErr && kwText.includes(smokeTag)) {
        break
      }
      await Bun.sleep(500)
    }
    if (kwErr) {
      fail(`keyword-filtered search returned isError=true: ${kwText}`)
    }
    if (!kwText.includes(smokeTag)) {
      fail(`keyword-filtered search did not find the labeled smoke message: ${kwText}`)
    }
    if (!kwText.includes('tags: receipt')) {
      fail(`keyword hit did not surface its 'receipt' tag: ${kwText}`)
    }
    pass('keyword-filtered search finds the labeled message and shows its tag')
  } else {
    process.stdout.write(
      '  (skipping round-trip check — MCP_SMOKE_TAG not set; pass the mail smoke tag in to enable)\n'
    )
  }

  // --- 3. Bad-input contract ------------------------------------------
  log('bad input: empty query')
  {
    const result = (await session.client.callTool({
      arguments: { query: '' },
      name: 'search_emails',
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] }
    if (!result.isError) {
      fail(`expected isError=true for empty query; got: ${JSON.stringify(result)}`)
    }
    pass('empty query rejected with isError=true')
  }

  log('bad input: limit above schema cap')
  {
    const result = (await session.client.callTool({
      arguments: { limit: 9999, query: 'x' },
      name: 'search_emails',
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] }
    if (!result.isError) {
      fail(`expected isError=true for limit=9999; got: ${JSON.stringify(result)}`)
    }
    pass('limit > 100 rejected with isError=true')
  }

  log('bad input: nonexistent mailbox')
  {
    const result = (await session.client.callTool({
      arguments: { mailbox: 'DoesNotExist', query: 'x' },
      name: 'search_emails',
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] }
    const { text, isError } = unwrapText(result)
    if (!isError) {
      fail(`expected isError=true for unknown mailbox; got: ${text}`)
    }
    if (!text.toLowerCase().includes('mailbox')) {
      fail(`unknown-mailbox error text did not mention 'mailbox': ${text}`)
    }
    pass('unknown mailbox → user-readable MCP error')
  }

  // --- 3b. search_contacts contract ------------------------------------
  //
  // The collected address book's content depends on the account's history,
  // so the deterministic checks are the contract, not specific people: a
  // query always answers without error (either ranked matches or the
  // instructive empty-result message — both say "matched"), and a missing
  // query is rejected by the schema.
  log('search_contacts: deterministic query contract')
  {
    const result = await callText('search_contacts', { query: `smoke-nobody-${Date.now()}` })
    if (result.isError) {
      fail(`search_contacts returned isError=true: ${result.text}`)
    }
    if (!result.text.includes('matched')) {
      fail(`search_contacts response missing the matched/empty contract text: ${result.text}`)
    }
    pass('search_contacts answers a query end-to-end (JMAP for Contacts reachable)')
  }

  log('bad input: search_contacts without a query')
  {
    const result = (await session.client.callTool({
      arguments: {},
      name: 'search_contacts',
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] }
    if (!result.isError) {
      fail(`expected isError=true for a missing query; got: ${JSON.stringify(result)}`)
    }
    pass('missing query rejected with isError=true')
  }

  // --- 4. Refresh-token round-trip ------------------------------------
  if (refreshToken) {
    log('exchange refresh token')
    const fresh = await exchangeRefresh({
      clientId,
      refreshToken,
      stalwartUrl: stalwart,
    })
    if (!fresh.access_token) {
      fail('refresh exchange returned no access_token')
    }
    pass('refresh exchange returned a new access_token')

    log('reconnect with the new bearer')
    await session.close()
    session = await connect(mcpUrl, fresh.access_token)
    const tools2 = await session.client.listTools()
    if (!tools2.tools.some((t) => t.name === 'search_emails')) {
      fail('post-refresh listTools missing search_emails')
    }
    pass('post-refresh listTools still works')
  } else {
    process.stdout.write('  (skipping refresh round-trip — MCP_REFRESH_TOKEN not set)\n')
  }

  await session.close()
  process.stdout.write(`\n${passed} checks passed\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`✗ ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
}
