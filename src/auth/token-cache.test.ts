import { describe, expect, test } from 'bun:test'

import { type CachedPrincipal, MAX_ENTRY_SECONDS, TokenCache } from './token-cache.ts'

const T0 = 1_900_000_000

// A cache on a clock the test moves.
const clocked = () => {
  let now = T0
  const cache = new TokenCache({ nowSec: () => now })
  return {
    at: (t: number) => {
      now = t
    },
    cache,
  }
}

const entry = (over: Partial<CachedPrincipal> = {}): CachedPrincipal => ({
  access: 'everything',
  exp: T0 + 3600,
  principal: 'alice@example.com',
  userId: 'user_123',
  ...over,
})

describe('TokenCache', () => {
  test('get returns undefined for unknown token', () => {
    expect(new TokenCache().get('nope')).toBeUndefined()
  })

  test('set then get within exp returns the entry', () => {
    const { cache } = clocked()
    cache.set('t1', entry())
    expect(cache.get('t1')).toEqual(entry())
  })

  test('an entry lives at most MAX_ENTRY_SECONDS even when the token lives longer', () => {
    const { at, cache } = clocked()
    cache.set('t1', entry())
    at(T0 + MAX_ENTRY_SECONDS - 1)
    expect(cache.get('t1')).toBeDefined()
    at(T0 + MAX_ENTRY_SECONDS)
    expect(cache.get('t1')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('an entry ends at the token exp when that comes sooner', () => {
    const { at, cache } = clocked()
    cache.set('t1', entry({ exp: T0 + 5 }))
    at(T0 + 4)
    expect(cache.get('t1')).toBeDefined()
    at(T0 + 5)
    expect(cache.get('t1')).toBeUndefined()
  })

  test('an expired token is never served', () => {
    const { cache } = clocked()
    cache.set('t1', entry({ exp: T0 - 1 }))
    expect(cache.get('t1')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('set overwrites a previous entry for the same token', () => {
    const { cache } = clocked()
    cache.set('t1', entry({ principal: 'alice' }))
    cache.set('t1', entry({ principal: 'bob' }))
    expect(cache.get('t1')?.principal).toBe('bob')
  })

  test('sweep removes all expired entries', () => {
    const { at, cache } = clocked()
    cache.set('dead', entry({ exp: T0 + 10, principal: 'x' }))
    cache.set('alive', entry({ principal: 'y' }))
    at(T0 + 10)
    cache.sweep()
    expect(cache.size).toBe(1)
    expect(cache.get('alive')?.principal).toBe('y')
    expect(cache.get('dead')).toBeUndefined()
  })
})
