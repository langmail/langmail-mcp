import { describe, expect, test } from 'bun:test'

import { createIdempotencyStore, IDEMPOTENCY_TTL_MINUTES } from './idempotency.ts'

describe('createIdempotencyStore', () => {
  test('replays a recorded value for the same principal and key', () => {
    const store = createIdempotencyStore<string>()
    expect(store.lookup('user@langmail.me', 'k1')).toBeNull()
    store.record('user@langmail.me', 'k1', 'sent d1')
    expect(store.lookup('user@langmail.me', 'k1')).toBe('sent d1')
  })

  test('scopes keys by principal, so two accounts cannot collide', () => {
    const store = createIdempotencyStore<string>()
    store.record('user@langmail.me', 'k1', 'theirs')
    expect(store.lookup('other@langmail.me', 'k1')).toBeNull()
  })

  test('cannot be tricked into a collision by a key that spans the scope boundary', () => {
    const store = createIdempotencyStore<string>()
    // Both calls concatenate to the same characters. The key is agent-supplied,
    // so a separator-joined scope would collide here and hand one caller the
    // other's recorded answer.
    store.record('a', 'bc', 'first')
    expect(store.lookup('ab', 'c')).toBeNull()
    expect(store.lookup('a', 'bc')).toBe('first')
  })

  test('forgets an entry once its TTL has passed', () => {
    let now = 1_000_000
    const store = createIdempotencyStore<string>(() => now)
    store.record('user@langmail.me', 'k1', 'sent d1')
    now += (IDEMPOTENCY_TTL_MINUTES - 1) * 60 * 1000
    expect(store.lookup('user@langmail.me', 'k1')).toBe('sent d1')
    now += 2 * 60 * 1000
    expect(store.lookup('user@langmail.me', 'k1')).toBeNull()
  })
})
