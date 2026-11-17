// In-memory replay cache for the composition tools' `idempotencyKey`.
//
// The failure mode this closes is specific to agents: a client calls
// `send_draft`, the response is lost (timeout, dropped connection, a retry
// wrapper that doesn't know the call had a side effect), and the client calls
// again. Without a key, the second call is indistinguishable from a deliberate
// second send. With one, the first call's answer is replayed and nothing leaves
// the mailbox twice.
//
// The value is the tool's result text, because replaying the exact answer is the
// point — not merely suppressing the write.
//
// Entries are scoped by (tool, principal), and both halves matter:
//
//   - by principal, so two accounts can't collide on the same key;
//   - by tool, because "one key per user request" is the natural way for an
//     agent to use these. Sharing a namespace would make
//     `create_draft(key: "k")` followed by `send_draft(key: "k")` look like a
//     retry of the create — so the send would be skipped, and the agent would be
//     handed the create's "Nothing has been sent" text as though it were the
//     send's answer. A retry is the same call again, not the next call in a
//     chain.
//
// Single-process state is fine here, for the same reason it is for attachment
// tickets: the server is one container. A restart loses the cache, which
// reopens the retry window rather than corrupting anything — and the
// "is this still a draft?" check in send_draft closes it structurally
// regardless of whether a key was passed.

export const IDEMPOTENCY_TTL_MINUTES = 15;
const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_MINUTES * 60 * 1000;

export interface IdempotencyStore<T> {
	// The recorded value for a key this tool and principal already used, or null.
	lookup: (tool: string, principal: string, key: string) => T | null;
	record: (tool: string, principal: string, key: string, value: T) => void;
}

// Length-prefixed rather than separator-joined, so no key — whatever bytes an
// agent puts in one — can be split differently and collide with another tool's
// or principal's entry. A separator only works if it cannot occur in the
// operands, and `key` is caller-supplied.
const scopedKey = (tool: string, principal: string, key: string): string =>
	`${tool.length}:${tool}${principal.length}:${principal}${key}`;

export const createIdempotencyStore = <T>(
	now: () => number = Date.now
): IdempotencyStore<T> => {
	const entries = new Map<string, { expiresAt: number; value: T }>();

	// Lazy sweep on access keeps the map bounded without a timer.
	const sweep = (): void => {
		const t = now();
		for (const [key, entry] of entries) {
			if (entry.expiresAt <= t) {
				entries.delete(key);
			}
		}
	};

	return {
		lookup: (tool, principal, key) => {
			sweep();
			return entries.get(scopedKey(tool, principal, key))?.value ?? null;
		},
		record: (tool, principal, key, value) => {
			sweep();
			entries.set(scopedKey(tool, principal, key), {
				expiresAt: now() + IDEMPOTENCY_TTL_MS,
				value,
			});
		},
	};
};
