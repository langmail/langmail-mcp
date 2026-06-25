import { describe, expect, test } from 'bun:test'

import { createReadiness, readyzResponse, stalwartReachable } from './readiness.ts'

describe('createReadiness', () => {
  test('reports ready when all checks pass', async () => {
    const readiness = createReadiness({ a: async () => 'HTTP 200', b: async () => 'ok' })
    const result = await readiness()
    expect(result.ready).toBe(true)
    expect(result.checks).toEqual({ a: 'HTTP 200', b: 'ok' })
  })

  test('reports not ready when a check throws', async () => {
    // biome-ignore lint/suspicious/useAwait: Check type expects Promise-returning function
    const readiness = createReadiness({
      up: async () => 'ok',
      // biome-ignore lint/suspicious/useAwait: Check type expects Promise-returning function
      down: async () => {
        throw new Error('ConnectionRefused')
      },
    })
    const result = await readiness()
    expect(result.ready).toBe(false)
    expect(result.checks.up).toBe('ok')
    expect(result.checks.down).toBe('ConnectionRefused')
  })

  test('marks a check that exceeds the timeout as not ready', async () => {
    const readiness = createReadiness(
      { slow: () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 50)) },
      { timeoutMs: 10 }
    )
    const result = await readiness()
    expect(result.ready).toBe(false)
    expect(result.checks.slow).toContain('timed out')
  })

  test('caches the aggregate result within the TTL', async () => {
    let calls = 0
    let clock = 1000
    // biome-ignore lint/suspicious/useAwait: Check type expects Promise-returning function
    const readiness = createReadiness(
      {
        // biome-ignore lint/suspicious/useAwait: Check type expects Promise-returning function
        x: async () => {
          calls += 1
          return 'ok'
        },
      },
      { ttlMs: 100, now: () => clock }
    )
    await readiness()
    await readiness()
    expect(calls).toBe(1)
    clock += 200
    await readiness()
    expect(calls).toBe(2)
  })
})

describe('readyzResponse', () => {
  test('maps ready→200 and not_ready→503', async () => {
    const ok = readyzResponse({ ready: true, checks: { a: 'ok' } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { status: string }).status).toBe('ready')
    const bad = readyzResponse({ ready: false, checks: { a: 'down' } })
    expect(bad.status).toBe(503)
    expect(((await bad.json()) as { status: string }).status).toBe('not_ready')
  })
})

describe('stalwartReachable', () => {
  test('returns the HTTP status on any response', async () => {
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 401 }))) as any
    try {
      const detail = await stalwartReachable('https://mail.example.com')(3000)
      expect(detail).toBe('HTTP 401')
    } finally {
      globalThis.fetch = original
    }
  })
})
