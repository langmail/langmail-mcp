import { describe, expect, spyOn, test } from 'bun:test'

import { logger } from '@langmail/logger'

import { TokenCache } from './auth/token-cache.ts'
import { createRoutes } from './handler.ts'

const PUBLIC = 'https://mcp.example.com'

const makeRoutes = (cache?: TokenCache) =>
  createRoutes({
    authIssuer: 'https://auth.example.com/api/auth',
    cache,
    observability: () => ({ activityRecording: true, errorTracking: true, logShipping: true }),
    publicUrl: PUBLIC,
    stalwartUrl: 'https://mail.example.com',
  })

// Spy on the shared logger rather than replacing the module: mock.module is
// process-wide for the whole test run, and a stale replacement would follow
// every other file that logs (see update-calendar-event.test.ts).
const requestLines = async (fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> => {
  const info = spyOn(logger, 'info').mockImplementation(() => undefined)
  try {
    await fn()
    return info.mock.calls
      .filter(([, msg]) => msg === 'mcp request')
      .map(([fields]) => fields as Record<string, unknown>)
  } finally {
    info.mockRestore()
  }
}

describe('/mcp request logging', () => {
  test('records method, route, status and duration for an authenticated request', async () => {
    const cache = new TokenCache()
    cache.set('good', { exp: Math.floor(Date.now() / 1000) + 60, principal: 'alice@langmail.me', userId: 'user_123' })

    const lines = await requestLines(() =>
      makeRoutes(cache).fetch(
        new Request(`${PUBLIC}/mcp`, { headers: { authorization: 'Bearer good' }, method: 'POST' })
      )
    )

    const [line] = lines
    expect(line?.method).toBe('POST')
    expect(line?.route).toBe('/mcp')
    // The phase-1 stub answers 501; what matters is that the outcome is recorded.
    expect(line?.status).toBe(501)
    expect(typeof line?.durationMs).toBe('number')
    // The principal is a mailbox address — it must never reach the log line.
    expect(JSON.stringify(line)).not.toContain('alice@langmail.me')
  })

  test('records a rejected request too — a 401 is an outcome, not a non-event', async () => {
    const lines = await requestLines(() => makeRoutes().fetch(new Request(`${PUBLIC}/mcp`, { method: 'POST' })))

    expect(lines[0]?.status).toBe(401)
  })

  test('leaves health and well-known routes unlogged', async () => {
    const routes = makeRoutes()

    const lines = await requestLines(async () => {
      await routes.fetch(new Request(`${PUBLIC}/healthz`))
      await routes.fetch(new Request(`${PUBLIC}/.well-known/oauth-protected-resource`))
    })

    expect(lines).toHaveLength(0)
  })
})
