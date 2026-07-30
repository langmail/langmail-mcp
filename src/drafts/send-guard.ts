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
// So a send reserves before it submits, and the reservation is keyed on
// something that is *the same on a retry* rather than on the caller's optional
// key — which is what makes it cover a client retrying blind, the likelier shape,
// since a client retrying without a key is a client not thinking about
// idempotency.
//
// What that stable thing is differs per tool, which is why the key is a
// parameter and not a draft id:
//
//   - send_draft is given a draftId, and a retry passes the same one.
//   - reply_to_message is given the id of the message being answered, and mints
//     a *fresh* draft on every call. Keying on the draft it just created would
//     reserve a different key each time and guard nothing at all, so it reserves
//     against the message it is replying to instead.
//
// The tool name is part of the key: both ids come from the same Email id space,
// so replying to message X and sending draft X must not collide.
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

// What a send reserves against: the tool, and an id that is identical on a retry
// of the same logical send.
export interface SendSubject {
  key: string
  tool: string
}

export interface SendGuard {
  // Keeps the reservation, marking delivery as unknown rather than in-flight.
  markUnknown: (principal: string, subject: SendSubject) => void
  // Drops the reservation — a further attempt is safe.
  release: (principal: string, subject: SendSubject) => void
  // Marks a send as running. Returns null when the caller may proceed, or the
  // existing reservation when it must not.
  reserve: (principal: string, subject: SendSubject) => SendReservation | null
}

const scopedKey = (principal: string, subject: SendSubject): string =>
  `${subject.tool.length}:${subject.tool}${principal.length}:${principal}${subject.key}`

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
    markUnknown: (principal, subject) => {
      entries.set(scopedKey(principal, subject), { expiresAt: now() + SEND_RESERVATION_TTL_MS, state: 'unknown' })
    },
    release: (principal, subject) => {
      entries.delete(scopedKey(principal, subject))
    },
    reserve: (principal, subject) => {
      sweep()
      const key = scopedKey(principal, subject)
      const held = entries.get(key)
      if (held) {
        return { state: held.state }
      }
      entries.set(key, { expiresAt: now() + SEND_RESERVATION_TTL_MS, state: 'in_flight' })
      return null
    },
  }
}
