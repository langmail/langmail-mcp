// Request-completion logging lives in its own file because asserting it means
// replacing @langmail/logger, and mock.module must run before the module under
// test is imported.

import { describe, expect, mock, test } from 'bun:test'

import { TokenCache } from './auth/token-cache.ts'

// The double carries every level because mock.module replaces the module for
// the whole test run, including files that only log in passing.
const info = mock((_fields: Record<string, unknown>, _msg: string) => undefined)
const error = mock((_fields: Record<string, unknown>, _msg: string) => undefined)
const noop = (): undefined => undefined
const logger = { child: () => logger, debug: noop, error, fatal: noop, info, trace: noop, warn: noop }
mock.module('@langmail/logger', () => ({ logger }))

const { createRoutes } = await import('./handler.ts')

const PUBLIC = 'https://mcp.example.com'

const makeRoutes = (cache?: TokenCache) =>
  createRoutes({
    authIssuer: 'https://auth.example.com/api/auth',
    cache,
    observability: () => ({ errorTracking: true, logShipping: true }),
    publicUrl: PUBLIC,
    stalwartUrl: 'https://mail.example.com',
  })

const requestLines = (): Record<string, unknown>[] =>
  info.mock.calls.filter(([, msg]) => msg === 'mcp request').map(([fields]) => fields)

describe('/mcp request logging', () => {
  test('records method, route, status and duration for an authenticated request', async () => {
    info.mockClear()
    const cache = new TokenCache()
    cache.set('good', { exp: Math.floor(Date.now() / 1000) + 60, principal: 'alice@langmail.me' })

    await makeRoutes(cache).fetch(
      new Request(`${PUBLIC}/mcp`, { headers: { authorization: 'Bearer good' }, method: 'POST' })
    )

    const [line] = requestLines()
    expect(line?.method).toBe('POST')
    expect(line?.route).toBe('/mcp')
    // The phase-1 stub answers 501; what matters is that the outcome is recorded.
    expect(line?.status).toBe(501)
    expect(typeof line?.durationMs).toBe('number')
    // The principal is a mailbox address — it must never reach the log line.
    expect(JSON.stringify(line)).not.toContain('alice@langmail.me')
  })

  test('records a rejected request too — a 401 is an outcome, not a non-event', async () => {
    info.mockClear()

    await makeRoutes().fetch(new Request(`${PUBLIC}/mcp`, { method: 'POST' }))

    expect(requestLines()[0]?.status).toBe(401)
  })

  test('leaves health and well-known routes unlogged', async () => {
    info.mockClear()
    const routes = makeRoutes()

    await routes.fetch(new Request(`${PUBLIC}/healthz`))
    await routes.fetch(new Request(`${PUBLIC}/.well-known/oauth-protected-resource`))

    expect(requestLines()).toHaveLength(0)
  })
})
