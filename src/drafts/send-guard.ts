// Reservation around an in-flight send.
//
// `idempotencyKey` and the "is this still a draft?" check both compare state,
// then act on it, and both leave a window between the two. That window is not
// exotic: it is exactly the case the key exists for. A client whose request
// times out fires the retry *while the first call is still running*, so the
// retry's `lookup` finds nothing recorded yet and its `isDraft` read still says
// "draft", because Stalwart hasn't applied the follow-up patch. Both calls
// submit, and the recipient gets two copies.
//
// So a send reserves before it submits. The reservation is keyed on the draft
// itself, not on the caller's key, which means it also covers a concurrent retry
// that passed no key at all — the more likely shape, since a client retrying
// blind is a client not thinking about idempotency.
//
// What happens when a submission *throws* is the interesting half, because the
// throw does not say whether the mail went out:
//
//   - Stalwart answered "no" (a JMAP method error carrying an error type, e.g.
//     `forbiddenFrom`): nothing was sent, so the reservation is released and the
//     call stays retryable.
//   - Anything else — a timeout, a reset, a proxy 502: the request may have been
//     accepted and the answer lost. Releasing would invite a retry that delivers
//     a second copy, so the reservation is *kept* and a later attempt is told the
//     outcome is unknown rather than being allowed to send again. Erring towards
//     "you must check" is the only safe direction: an unsent message the user
//     re-sends by hand costs a minute, a duplicate cannot be recalled.
//
// Single-process state, like the replay cache next door: one container, and a
// restart merely reopens the window.

export const SEND_RESERVATION_TTL_MINUTES = 10
const SEND_RESERVATION_TTL_MS = SEND_RESERVATION_TTL_MINUTES * 60 * 1000

export type SendReservation =
  // A send for this draft is running right now.
  | { state: 'in_flight' }
  // A send for this draft failed in a way that leaves delivery unknown.
  | { state: 'unknown' }

export interface SendGuard {
  // Keeps the reservation, marking delivery as unknown rather than in-flight.
  markUnknown: (principal: string, draftId: string) => void
  // Drops the reservation — the submission definitively did not happen.
  release: (principal: string, draftId: string) => void
  // Marks a send as running. Returns null when the caller may proceed, or the
  // existing reservation when it must not.
  reserve: (principal: string, draftId: string) => SendReservation | null
}

const scopedKey = (principal: string, draftId: string): string => `${principal.length}:${principal}${draftId}`

export const createSendGuard = (now: () => number = Date.now): SendGuard => {
  const entries = new Map<string, { expiresAt: number; state: SendReservation['state'] }>()

  const sweep = (): void => {
    const t = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(key)
      }
    }
  }

  return {
    markUnknown: (principal, draftId) => {
      entries.set(scopedKey(principal, draftId), { expiresAt: now() + SEND_RESERVATION_TTL_MS, state: 'unknown' })
    },
    release: (principal, draftId) => {
      entries.delete(scopedKey(principal, draftId))
    },
    reserve: (principal, draftId) => {
      sweep()
      const key = scopedKey(principal, draftId)
      const held = entries.get(key)
      if (held) {
        return { state: held.state }
      }
      entries.set(key, { expiresAt: now() + SEND_RESERVATION_TTL_MS, state: 'in_flight' })
      return null
    },
  }
}
