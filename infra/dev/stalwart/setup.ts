// Prepare the local Stalwart (infra/dev/stalwart/docker-compose.yml) for native mailbox
// provisioning, fully headless. Steps:
//   1. Wait for the JMAP session endpoint.
//   2. If the server is in bootstrap mode (fresh volume), complete setup via the
//      `Bootstrap` object — the only thing reachable until setup is done — with a
//      valid hostname, `langmail.me` as the default domain, and TLS/DKIM off (no
//      ACME/DNS locally). This also creates the langmail.me domain.
//   3. Restart the container so the mode change takes effect, then ensure the
//      langmail.me domain exists (the provision worker resolves it every job).
//   4. Log to stdout: the image's default tracer writes to /var/log/stalwart/,
//      a directory the image never creates, so nothing after bootstrap would be
//      logged. A Stdout tracer makes `docker logs stalwart-dev` the log.
//   5. Turn Stalwart's permissive CORS off, as infra/bootstrap/05-http.json.tmpl
//      does in production: every JMAP client is server-side.
//   6. Answer CardDAV requests that name no vCard version with 3.0, as
//      infra/bootstrap/19-address-book.json.tmpl does in production: iPhone
//      Contacts reads 4.0 as Latin-1.
//   7. Clear any stored Enterprise license and template overrides, as
//      infra/bootstrap/12-enterprise.json.tmpl does in production: Stalwart runs
//      as Community Edition (docs/adr/0022-stalwart-runs-as-community-edition.md).
//   8. With STALWART_OIDC_ISSUER_URL set (process-compose does), make Better Auth
//      the sole auth directory — the same shape
//      infra/bootstrap/08-oidc-directory.json.tmpl gives production, so MCP
//      bearer tokens validate locally. Skipped in CI (no issuer there).
//
// Idempotent: re-running once set up is a no-op. Talks raw JMAP (the admin
// contract) so the harness needs no stalwart-cli — see stalwart-admin-contract.md.
//
//   bun run stalwart:setup
//
// Copied from langmail/platform's services/auth/dev/setup-stalwart.ts, which
// also prepares the dev Stalwart for Langmail's Auth service; keep the two in
// step when Stalwart's setup changes.

const ADMIN_URL = process.env.STALWART_ADMIN_URL ?? 'http://127.0.0.1:9090'
const CONTAINER = 'stalwart-dev'
// Deterministic from STALWART_RECOVERY_ADMIN in docker-compose.yml.
const AUTHORIZATION = `Basic ${Buffer.from('admin:devpassword').toString('base64')}`
const DOMAIN = 'langmail.me'
const TRAILING_SLASH = /\/$/

const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']
const ADMIN_CAPABILITY = 'urn:stalwart:jmap'

interface JmapSession {
  accounts?: Record<string, unknown>
  apiUrl: string
  primaryAccounts?: Record<string, string>
}
interface Resolved {
  accountId: string
  apiUrl: string
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Poll the session endpoint until Stalwart answers and resolve the absolute
// apiUrl + admin accountId. Resolve it like StalwartAdminClient does (RFC 8620
// §2): absolute under process-compose (the public https mail origin — export
// NODE_EXTRA_CA_CERTS when running this by hand), relative on a fresh CI server.
async function waitForSession(): Promise<Resolved> {
  const deadline = Date.now() + 90_000
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ADMIN_URL}/jmap/session`, { headers: { authorization: AUTHORIZATION } })
      if (res.status === 200) {
        const body = (await res.json()) as JmapSession
        const accountId = body.primaryAccounts?.[ADMIN_CAPABILITY] ?? Object.keys(body.accounts ?? {})[0]
        if (body.apiUrl && accountId) {
          return { apiUrl: new URL(body.apiUrl, `${ADMIN_URL}/`).toString(), accountId }
        }
        lastError = 'malformed session (no apiUrl/accountId)'
      } else {
        lastError = `session returned ${res.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    process.stdout.write('.')
    await sleep(2000)
  }
  throw new Error(`Stalwart not reachable at ${ADMIN_URL} after 90s (last: ${lastError})`)
}

interface CallResult {
  error?: string
  payload: Record<string, unknown>
}

async function call(s: Resolved, method: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await fetch(s.apiUrl, {
    method: 'POST',
    headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
    body: JSON.stringify({ using: USING, methodCalls: [[method, { accountId: s.accountId, ...args }, '0']] }),
  })
  if (res.status !== 200) {
    throw new Error(`${method} returned HTTP ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] }
  const response = body.methodResponses?.[0]
  if (!response) {
    throw new Error(`${method}: empty methodResponses`)
  }
  const [name, payload] = response
  if (name === 'error') {
    return { payload, error: String((payload as { description?: string }).description ?? JSON.stringify(payload)) }
  }
  return { payload }
}

async function dockerRestart(): Promise<void> {
  const proc = Bun.spawn(['docker', 'restart', CONTAINER], { stdout: 'ignore', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`docker restart ${CONTAINER} failed: ${await new Response(proc.stderr).text()}`)
  }
}

// Returns stdout + stderr: `docker logs` replays the container's stderr on
// stderr, and Stalwart reports config-build failures there (they happen
// before the configured tracer is up).
async function dockerRun(args: string[]): Promise<string> {
  const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`docker ${args[0]} ${CONTAINER} failed: ${err}`)
  }
  return out + err
}

// Stalwart builds the OIDC directory when its config loads, fetching the
// issuer's discovery document and JWKS. If either fails at that moment (auth
// still starting, first-boot key generation), the directory is dropped until
// the next reload and every bearer-token request 401s. So: wait for both before any
// reload that involves the issuer, and verify afterwards from the container
// log (the Stdout tracer) that nothing failed to build.
async function waitForIssuer(issuerUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const discovery = await fetch(`${issuerUrl.replace(TRAILING_SLASH, '')}/.well-known/openid-configuration`)
      if (discovery.status === 200) {
        const { jwks_uri: jwksUri } = (await discovery.json()) as { jwks_uri?: string }
        const jwks = jwksUri ? await fetch(jwksUri) : null
        if (jwks?.status === 200) {
          return
        }
        lastError = `jwks ${jwksUri ?? '(missing jwks_uri)'} returned ${jwks?.status ?? 'nothing'}`
      } else {
        lastError = `discovery returned ${discovery.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    process.stdout.write('.')
    await sleep(2000)
  }
  throw new Error(`issuer ${issuerUrl} not ready after 90s (last: ${lastError})`)
}

async function configBuildErrors(): Promise<string[]> {
  const startedAt = (await dockerRun(['inspect', '-f', '{{.State.StartedAt}}', CONTAINER])).trim()
  const logs = await dockerRun(['logs', '--since', startedAt, CONTAINER])
  return logs.split('\n').filter((line) => line.includes('registry.build-error'))
}

// Runs at the end of every setup (fresh or no-op): a Stalwart that came up
// before auth on a plain `process-compose up` has the directory configured but
// not built. One reload with the issuer reachable fixes it; if it still fails,
// surface the reason instead of leaving SSO silently broken.
async function ensureDirectoryLoaded(issuerUrl: string): Promise<void> {
  if ((await configBuildErrors()).length === 0) {
    return
  }
  console.log('Stalwart reported config build errors since its last start; reloading with the issuer reachable...')
  await waitForIssuer(issuerUrl)
  await dockerRestart()
  await waitForSession()
  await sleep(3000)
  const errors = await configBuildErrors()
  if (errors.length > 0) {
    throw new Error(`Stalwart config still fails to build:\n${errors.join('\n')}`)
  }
  console.log('Directory loaded cleanly after reload.')
}

async function completeBootstrap(s: Resolved): Promise<void> {
  console.log('Server in bootstrap mode — completing setup...')
  const { payload, error } = await call(s, 'x:Bootstrap/set', {
    update: {
      singleton: {
        defaultHostname: 'mail.langmail.me',
        defaultDomain: DOMAIN,
        requestTlsCertificate: false,
        generateDkimKeys: false,
      },
    },
  })
  const updated = (payload.updated as Record<string, unknown> | undefined)?.singleton
  if (error || !updated) {
    const notUpdated = (payload.notUpdated as Record<string, unknown> | undefined)?.singleton
    throw new Error(`bootstrap completion failed: ${JSON.stringify(notUpdated ?? error ?? payload)}`)
  }
  console.log('Bootstrap completed; restarting container so the mode change takes effect...')
  await dockerRestart()
}

// Update a Stalwart singleton via JMAP. Singletons are addressed by the fixed id
// `singleton` (same shape completeBootstrap uses for Bootstrap) and always exist,
// so no create is needed. JMAP reports failures under `notUpdated` — a successful
// update returns the id under `updated` (possibly with a null value), so gate on
// `notUpdated`/`error` rather than truthiness of the updated object.
async function setSingleton(s: Resolved, method: string, fields: Record<string, unknown>): Promise<void> {
  const { payload, error } = await call(s, `${method}/set`, {
    update: { singleton: fields },
  })
  const notUpdated = (payload.notUpdated as Record<string, unknown> | undefined)?.singleton
  if (error || notUpdated) {
    throw new Error(`${method} update failed: ${JSON.stringify(notUpdated ?? error ?? payload)}`)
  }
}

interface TracerRecord {
  '@type'?: string
  id: string
}

// Replace whatever tracers exist with a single Stdout tracer (a no-op when
// that is already the state). Takes effect on config load — the caller restarts.
async function applyStdoutTracer(s: Resolved): Promise<boolean> {
  const query = await call(s, 'x:Tracer/query', {})
  if (query.error) {
    throw new Error(`Tracer/query failed: ${query.error}`)
  }
  const ids = (query.payload.ids as string[] | undefined) ?? []
  if (ids.length === 1) {
    const get = await call(s, 'x:Tracer/get', { ids, properties: ['@type'] })
    if ((get.payload.list as TracerRecord[] | undefined)?.[0]?.['@type'] === 'Stdout') {
      return false
    }
  }
  const { payload, error } = await call(s, 'x:Tracer/set', {
    destroy: ids,
    create: { stdout: { '@type': 'Stdout', enable: true, level: 'info', ansi: false, multiline: false } },
  })
  const created = (payload.created as { stdout?: { id?: string } } | undefined)?.stdout?.id
  if (error || !created) {
    throw new Error(`stdout tracer not created: ${JSON.stringify(payload.notCreated ?? error ?? payload)}`)
  }
  console.log('Tracer switched to stdout (docker logs stalwart-dev).')
  return true
}

// Mirror infra/bootstrap/05-http.json.tmpl: permissive CORS off. Runs on every
// setup, not only with the OIDC directory, so a dev volume that persisted the
// old `true` is reconciled. Takes effect on config load — the caller restarts.
async function applyStrictCors(s: Resolved): Promise<boolean> {
  const { payload, error } = await call(s, 'x:Http/get', { ids: ['singleton'], properties: ['usePermissiveCors'] })
  if (error) {
    throw new Error(`Http/get failed: ${error}`)
  }
  if ((payload.list as { usePermissiveCors?: boolean }[] | undefined)?.[0]?.usePermissiveCors === false) {
    return false
  }
  await setSingleton(s, 'x:Http', { usePermissiveCors: false })
  console.log('Permissive CORS turned off.')
  return true
}

// Mirror infra/bootstrap/19-address-book.json.tmpl: answer CardDAV requests
// that name no vCard version with 3.0, whose CHARSET=UTF-8 iPhone Contacts
// decodes correctly (it reads 4.0 as Latin-1). Takes effect on config load —
// the caller restarts.
async function applyVCard3Default(s: Resolved): Promise<boolean> {
  const { payload, error } = await call(s, 'x:AddressBook/get', { ids: ['singleton'], properties: ['vCardVersion'] })
  if (error) {
    throw new Error(`AddressBook/get failed: ${error}`)
  }
  if ((payload.list as { vCardVersion?: string }[] | undefined)?.[0]?.vCardVersion === 'v3') {
    return false
  }
  await setSingleton(s, 'x:AddressBook', { vCardVersion: 'v3' })
  console.log('Default vCard version set to 3.0.')
  return true
}

interface DirectoryRecord {
  '@type'?: string
  id: string
  issuerUrl?: string
}

// True when the server already has exactly this state, so the (restarting)
// apply step can be skipped — keeps every `process-compose up` a no-op.
async function hasOidcDirectory(s: Resolved, ids: string[], issuerUrl: string): Promise<boolean> {
  if (ids.length !== 1) {
    return false
  }
  const [directories, authentication] = await Promise.all([
    call(s, 'x:Directory/get', { ids, properties: ['@type', 'issuerUrl'] }),
    call(s, 'x:Authentication/get', { ids: ['singleton'], properties: ['directoryId'] }),
  ])
  const directory = (directories.payload.list as DirectoryRecord[] | undefined)?.[0]
  const directoryId = (authentication.payload.list as { directoryId?: string }[] | undefined)?.[0]?.directoryId
  return directory?.['@type'] === 'Oidc' && directory.issuerUrl === issuerUrl && directoryId === directory.id
}

// Mirror infra/bootstrap/08-oidc-directory.json.tmpl: replace every Directory
// with one Oidc directory for the given issuer and make it the auth directory.
// The directory switch takes effect on config load, so the container is
// restarted afterwards; returns whether it did.
async function applyOidcDirectory(s: Resolved, issuerUrl: string): Promise<boolean> {
  const existing = await call(s, 'x:Directory/query', {})
  if (existing.error) {
    throw new Error(`Directory/query failed: ${existing.error}`)
  }
  const ids = (existing.payload.ids as string[] | undefined) ?? []
  if (await hasOidcDirectory(s, ids, issuerUrl)) {
    console.log(`Better Auth (${issuerUrl}) already is the sole auth directory.`)
    return false
  }

  console.log(`Configuring Better Auth (${issuerUrl}) as the sole auth directory...`)
  await waitForIssuer(issuerUrl)
  const { payload, error } = await call(s, 'x:Directory/set', {
    destroy: ids,
    create: {
      oidc: {
        '@type': 'Oidc',
        description: 'Better Auth (langmail OpenID Provider)',
        issuerUrl,
        claimUsername: 'email',
        claimName: 'name',
        acceptedAudiences: {},
        skipAudienceValidation: false,
        opaqueTokenValidation: 'userInfo',
        unscopedTokens: 'interoperable',
        allowIdTokenClaims: false,
        lenientIssuerMatch: false,
        allowInvalidCerts: false,
      },
    },
  })
  const directoryId = (payload.created as { oidc?: { id?: string } } | undefined)?.oidc?.id
  if (error || !directoryId) {
    const notCreated = (payload.notCreated as Record<string, unknown> | undefined)?.oidc
    throw new Error(`OIDC directory not created: ${JSON.stringify(notCreated ?? error ?? payload)}`)
  }
  const notDestroyed = payload.notDestroyed as Record<string, unknown> | undefined
  if (notDestroyed && Object.keys(notDestroyed).length > 0) {
    throw new Error(`old directories not destroyed: ${JSON.stringify(notDestroyed)}`)
  }
  await setSingleton(s, 'x:Authentication', { directoryId })

  console.log('Directory stored; restarting container so the auth directory switch loads...')
  await dockerRestart()
  await waitForSession()
  console.log(`OIDC directory ${directoryId} is the auth directory.`)
  return true
}

interface EnterpriseRecord {
  apiKey?: { '@type'?: string }
  licenseKey?: { '@type'?: string }
}

// Mirror infra/bootstrap/12-enterprise.json.tmpl: Stalwart runs as Community
// Edition, so no license or license API key is stored (ADR 0022). Any stored
// one is cleared, together with the calendar template overrides that only a
// license makes effective (13-calendar-scheduling, 14-calendar-alarm), so dev
// matches prod. Takes effect on config load — the caller restarts.
async function applyCommunityEdition(s: Resolved): Promise<boolean> {
  const { payload, error } = await call(s, 'x:Enterprise/get', {
    ids: ['singleton'],
    properties: ['licenseKey', 'apiKey'],
  })
  if (error) {
    throw new Error(`Enterprise/get failed: ${error}`)
  }
  const enterprise = (payload.list as EnterpriseRecord[] | undefined)?.[0]
  const licensed = [enterprise?.licenseKey, enterprise?.apiKey].some((key) => (key?.['@type'] ?? 'None') !== 'None')
  if (!licensed) {
    return false
  }
  // The license goes last: the early return above keys on it, so a run cut
  // short after the templates is finished by the next one.
  await setSingleton(s, 'x:CalendarScheduling', { emailTemplate: null, httpRsvpTemplate: null })
  await setSingleton(s, 'x:CalendarAlarm', { template: null })
  await setSingleton(s, 'x:Enterprise', { licenseKey: { '@type': 'None' }, apiKey: { '@type': 'None' }, logo: null })
  console.log('Enterprise license cleared; Stalwart runs as Community Edition.')
  return true
}

async function main(): Promise<void> {
  console.log(`Waiting for Stalwart at ${ADMIN_URL} ...`)
  let session = await waitForSession()

  // Probe with a real admin method; a fresh instance rejects it. Observed 0.16.6
  // error: type="forbidden", description="The server is in bootstrap mode. Only
  // the 'Bootstrap' object type can be accessed until the bootstrap process is
  // complete." Match on the "bootstrap" token in that description — it is the
  // most specific signal (the bare `forbidden` type covers other errors too).
  let query = await call(session, 'x:Domain/query', { filter: { name: DOMAIN } })
  if (query.error?.toLowerCase().includes('bootstrap')) {
    await completeBootstrap(session)
    session = await waitForSession()
    query = await call(session, 'x:Domain/query', { filter: { name: DOMAIN } })
  }
  if (query.error) {
    throw new Error(`Domain/query failed: ${query.error}`)
  }

  const existingId = (query.payload.ids as string[] | undefined)?.[0]
  if (existingId) {
    console.log(`Domain ${DOMAIN} present (id=${existingId}).`)
  } else {
    const { payload, error } = await call(session, 'x:Domain/set', {
      create: { d1: { '@type': 'Domain', name: DOMAIN, enable: true } },
    })
    const id = (payload.created as { d1?: { id?: string } } | undefined)?.d1?.id
    if (error || !id) {
      const notCreated = (payload.notCreated as Record<string, unknown> | undefined)?.d1
      throw new Error(`domain not created: ${JSON.stringify(notCreated ?? error ?? payload)}`)
    }
    console.log(`Created domain ${DOMAIN} (id=${id}).`)
  }

  const tracerChanged = await applyStdoutTracer(session)
  const corsChanged = await applyStrictCors(session)
  const vCardChanged = await applyVCard3Default(session)
  const editionChanged = await applyCommunityEdition(session)

  const oidcIssuerUrl = process.env.STALWART_OIDC_ISSUER_URL
  let restarted = false
  if (oidcIssuerUrl) {
    restarted = await applyOidcDirectory(session, oidcIssuerUrl)
  } else {
    console.log('\nℹ️  STALWART_OIDC_ISSUER_URL not set — internal directory stays primary (CI mode).')
  }
  if (!restarted && (tracerChanged || corsChanged || vCardChanged || editionChanged)) {
    // applyOidcDirectory restarts only when it changed something; otherwise
    // load the tracer, CORS, vCard and edition settings with a restart of our own.
    console.log('Restarting container so the tracer, CORS, vCard and edition settings load...')
    await dockerRestart()
    await waitForSession()
  }
  if (oidcIssuerUrl) {
    await ensureDirectoryLoaded(oidcIssuerUrl)
  }

  console.log('\n✅ Local Stalwart ready. process-compose passes these to auth; export them for dev scripts:\n')
  console.log(`STALWART_ADMIN_URL=${ADMIN_URL}`)
  console.log(`STALWART_ADMIN_AUTHORIZATION=${AUTHORIZATION}`)
  console.log(
    '\n(Do NOT add REDIS_HOST to .env — it switches Better Auth to Redis session\n' +
      ' storage and breaks the integration tests. The default trigger needs no\n' +
      ' Redis; for --enqueue set REDIS_HOST inline — see\n' +
      ' docs/guides/local-development.md § Debugging mailbox provisioning.)'
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nsetup-stalwart failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
