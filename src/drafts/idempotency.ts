// In-memory replay cache for the composition tools' `idempotencyKey`.
//
// The failure mode this closes is specific to agents: a client calls
// `send_draft`, the response is lost (timeout, dropped connection, a retry
// wrapper that doesn't know the call had a side effect), and the client calls
// again. Without a key, the second call is indistinguishable from a deliberate
// second send. With one, the first call's answer is replayed and nothing leaves
// the mailbox twice.
//
// Entries are scoped by principal so two accounts can't collide on the same
// key, and the value is the tool's result text — replaying the exact answer is
// the point, not just suppressing the write.
//
// Single-process state is fine here, for the same reason it is for attachment
// tickets: the server is one container. A restart loses the cache, which
// reopens the retry window rather than corrupting anything — and the
// "is this still a draft?" check in send_draft closes it structurally
// regardless of whether a key was passed.

export const IDEMPOTENCY_TTL_MINUTES = 15
const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_MINUTES * 60 * 1000

export interface IdempotencyStore<T> {
  // The recorded value for a key this principal already used, or null.
  lookup: (principal: string, key: string) => T | null
  record: (principal: string, key: string, value: T) => void
}

// Length-prefixed rather than separator-joined, so no key — whatever bytes an
// agent puts in one — can be split differently and collide with another
// principal's entry. A separator only works if it cannot occur in the operands,
// and `key` is caller-supplied.
const scopedKey = (principal: string, key: string): string => `${principal.length}:${principal}${key}`

export const createIdempotencyStore = <T>(now: () => number = Date.now): IdempotencyStore<T> => {
  const entries = new Map<string, { expiresAt: number; value: T }>()

  // Lazy sweep on access keeps the map bounded without a timer.
  const sweep = (): void => {
    const t = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(key)
      }
    }
  }

  return {
    lookup: (principal, key) => {
      sweep()
      return entries.get(scopedKey(principal, key))?.value ?? null
    },
    record: (principal, key, value) => {
      sweep()
      entries.set(scopedKey(principal, key), { expiresAt: now() + IDEMPOTENCY_TTL_MS, value })
    },
  }
}
