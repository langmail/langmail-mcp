import { describe, expect, test } from 'bun:test'

import { createIdempotencyStore, IDEMPOTENCY_TTL_MINUTES } from './idempotency.ts'

const USER = 'user@langmail.me'

describe('createIdempotencyStore', () => {
  test('replays a recorded value for the same tool, principal, and key', () => {
    const store = createIdempotencyStore<string>()
    expect(store.lookup('send_draft', USER, 'k1')).toBeNull()
    store.record('send_draft', USER, 'k1', 'sent d1')
    expect(store.lookup('send_draft', USER, 'k1')).toBe('sent d1')
  })

  test('scopes keys by principal, so two accounts cannot collide', () => {
    const store = createIdempotencyStore<string>()
    store.record('send_draft', USER, 'k1', 'theirs')
    expect(store.lookup('send_draft', 'other@langmail.me', 'k1')).toBeNull()
  })

  test('scopes keys by tool, so a create key does not suppress the send', () => {
    const store = createIdempotencyStore<string>()
    // "One key per user request" is the natural way for an agent to use these.
    // Sharing a namespace would make the send look like a retry of the create
    // and skip it — while reporting the create's "nothing has been sent" text.
    store.record('create_draft', USER, 'task-42', 'Draft staged in Drafts.')
    expect(store.lookup('send_draft', USER, 'task-42')).toBeNull()
    expect(store.lookup('reply_to_message', USER, 'task-42')).toBeNull()
    expect(store.lookup('create_draft', USER, 'task-42')).toBe('Draft staged in Drafts.')
  })

  test('cannot be tricked into a collision by a key that spans a scope boundary', () => {
    const store = createIdempotencyStore<string>()
    // Both calls concatenate to the same characters. The key is agent-supplied,
    // so a separator-joined scope would collide here and hand one caller the
    // other's recorded answer.
    store.record('send_draft', 'a', 'bc', 'first')
    expect(store.lookup('send_draft', 'ab', 'c')).toBeNull()
    expect(store.lookup('send_draft', 'a', 'bc')).toBe('first')
    store.record('a', 'b', 'c', 'tool-a')
    expect(store.lookup('ab', '', 'c')).toBeNull()
  })

  test('forgets an entry once its TTL has passed', () => {
    let now = 1_000_000
    const store = createIdempotencyStore<string>(() => now)
    store.record('send_draft', USER, 'k1', 'sent d1')
    now += (IDEMPOTENCY_TTL_MINUTES - 1) * 60 * 1000
    expect(store.lookup('send_draft', USER, 'k1')).toBe('sent d1')
    now += 2 * 60 * 1000
    expect(store.lookup('send_draft', USER, 'k1')).toBeNull()
  })
})
