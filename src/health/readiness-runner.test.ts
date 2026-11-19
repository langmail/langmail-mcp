import { describe, expect, test } from 'bun:test'

import { createReadiness, readyzResponse } from './readiness-runner.ts'

describe('createReadiness', () => {
  test('reports ready when all checks pass', async () => {
    const readiness = createReadiness({ a: async () => 'HTTP 200', b: () => Promise.resolve('ok') })
    const result = await readiness()
    expect(result.ready).toBe(true)
    expect(result.checks).toEqual({ a: 'HTTP 200', b: 'ok' })
  })

  test('reports not ready when a check throws', async () => {
    const readiness = createReadiness({
      up: () => Promise.resolve('ok'),
      down: () => Promise.reject(new Error('ConnectionRefused')),
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

  test('caches a ready result within the TTL', async () => {
    let calls = 0
    let clock = 1000
    const readiness = createReadiness(
      {
        x: () => {
          calls += 1
          return Promise.resolve('ok')
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

  test('reruns the checks on the next request after a failed check', async () => {
    let calls = 0
    let fail = true
    const readiness = createReadiness(
      {
        auth: () => {
          calls += 1
          return fail ? Promise.reject(new Error('timed out after 3000ms')) : Promise.resolve('HTTP 401')
        },
      },
      { ttlMs: 10_000, now: () => 1000 }
    )
    expect((await readiness()).ready).toBe(false)
    fail = false
    const second = await readiness()
    expect(calls).toBe(2)
    expect(second).toEqual({ ready: true, checks: { auth: 'HTTP 401' } })
  })

  test('reports every request as not ready while a dependency stays down', async () => {
    let calls = 0
    const readiness = createReadiness(
      {
        up: () => Promise.resolve('HTTP 200'),
        auth: () => {
          calls += 1
          return Promise.reject(new Error('ConnectionRefused'))
        },
      },
      { ttlMs: 10_000, now: () => 1000 }
    )
    for (let i = 0; i < 3; i += 1) {
      const result = await readiness()
      expect(result.ready).toBe(false)
      expect(result.checks.auth).toBe('ConnectionRefused')
      expect(readyzResponse(result).status).toBe(503)
    }
    expect(calls).toBe(3)
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

  test('reports extra details alongside the checks without changing the verdict', async () => {
    const res = readyzResponse({ ready: true, checks: { a: 'ok' } }, { observability: { logShipping: false } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { observability: Record<string, boolean> }
    expect(body.observability).toEqual({ logShipping: false })
  })
})
