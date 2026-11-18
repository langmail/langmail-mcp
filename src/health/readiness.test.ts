import { describe, expect, test } from 'bun:test'

import { authReachable, stalwartReachable } from './readiness.ts'

describe('authReachable', () => {
  test('probes Better Auth userinfo and returns the HTTP status', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = ((url: string) => {
      seen.push(url)
      return Promise.resolve(new Response(null, { status: 401 }))
    }) as unknown as typeof fetch
    try {
      const detail = await authReachable('https://auth.example.com/api/auth')(3000)
      expect(detail).toBe('HTTP 401')
      expect(seen[0]).toBe('https://auth.example.com/api/auth/oauth2/userinfo')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('stalwartReachable', () => {
  test('probes Stalwart JMAP and returns the HTTP status', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = ((url: string) => {
      seen.push(url)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch
    try {
      const detail = await stalwartReachable('https://mail.example.com')(3000)
      expect(detail).toBe('HTTP 200')
      expect(seen[0]).toBe('https://mail.example.com/jmap/session')
    } finally {
      globalThis.fetch = original
    }
  })
})
