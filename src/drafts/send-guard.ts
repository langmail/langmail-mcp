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
// So a send reserves *first* — in the same synchronous step as its replay
// lookup, before its first await — and holds the reservation until the call
// ends, recording its replay before letting go. Both checks then mean
// something: a retry that gets past `reserve` knows the earlier call has
// finished, so the replay it looked up in that same step is already recorded,
// and its `isDraft` read sees the mailbox after that call's submission.
// Reserving any later reopens the window: the retry reads "still a draft" while
// the first call is in flight, waits on its own I/O, and reserves after the
// first call has released — then submits a message that has already gone.
// `spec/SendProtocol.tla` checks this ordering; change it there first.
//
// The reservation is keyed on something that is *the same on a retry* rather
// than on the caller's optional key — which is what makes it cover a client
// retrying blind, the likelier shape, since a client retrying without a key is a
// client not thinking about idempotency.
//
// What that stable thing is differs per tool, which is why the key is a
// parameter and not a draft id:
//
//   - send_draft is given a draftId, and a retry passes the same one.
//   - reply_to_message is given the id of the message being answered, and mints
//     a *fresh* draft on every call. Keying on the draft it just created would
//     reserve a different key each time and guard nothing at all, so it reserves
//     against the message it is replying to instead — and then also covers the
//     draft it staged under send_draft's key, because its result names that draft
//     and a send_draft of it must not race, or follow an unknown outcome of, the
//     reply's own submission.
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

// reply_to_message's tool name. Its subjects are the message being answered,
// which the refusal text has to name differently; the tool keys its replay
// cache under the same name.
export const REPLY_TOOL = 'reply_to_message'

// forward_message's tool name. Like a reply, its subjects are the message being
// forwarded, and it keys its replay cache under the same name.
export const FORWARD_TOOL = 'forward_message'

// What a send reserves against: the tool, and an id that is identical on a retry
// of the same logical send.
export interface SendSubject {
  key: string
  tool: string
}

// `owner` ties an entry to the call that took it. A call can outlive its
// reservation's TTL, and by then a retry may hold the same subject: settling by
// subject alone would release — or mark unknown — the retry's live entry. With
// an owner, release and markUnknown only touch the caller's own entry.
export interface SendGuard {
  // Keeps the reservation, marking delivery as unknown rather than in-flight.
  markUnknown: (principal: string, subject: SendSubject, owner?: symbol) => void
  // Drops the reservation — a further attempt is safe.
  release: (principal: string, subject: SendSubject, owner?: symbol) => void
  // Marks a send as running. Returns null when the caller may proceed, or the
  // existing reservation when it must not.
  reserve: (principal: string, subject: SendSubject, owner?: symbol) => SendReservation | null
}

const scopedKey = (principal: string, subject: SendSubject): string =>
  `${subject.tool.length}:${subject.tool}${principal.length}:${principal}${subject.key}`

export const createSendGuard = (now: () => number = Date.now): SendGuard => {
  const entries = new Map<string, { expiresAt: number; owner?: symbol; state: SendReservation['state'] }>()

  // Another call's live entry is left alone. An unowned settle acts
  // unconditionally, and so does one whose entry has already been swept:
  // dropping an `unknown` there would let the next call send a second copy.
  const ownedBy = (key: string, owner: symbol | undefined): boolean => {
    const held = entries.get(key)
    return owner === undefined || held === undefined || held.owner === owner
  }

  const sweep = (): void => {
    const t = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(key)
      }
    }
  }

  return {
    markUnknown: (principal, subject, owner) => {
      const key = scopedKey(principal, subject)
      if (ownedBy(key, owner)) {
        entries.set(key, { expiresAt: now() + SEND_RESERVATION_TTL_MS, owner, state: 'unknown' })
      }
    },
    release: (principal, subject, owner) => {
      const key = scopedKey(principal, subject)
      if (ownedBy(key, owner)) {
        entries.delete(key)
      }
    },
    reserve: (principal, subject, owner) => {
      sweep()
      const key = scopedKey(principal, subject)
      const held = entries.get(key)
      if (held) {
        return { state: held.state }
      }
      entries.set(key, { expiresAt: now() + SEND_RESERVATION_TTL_MS, owner, state: 'in_flight' })
      return null
    },
  }
}

// Why a send was refused because another call holds its subject. Nothing was
// sent by the refused call in either case. A reply's subject is the message
// being answered, and reading that back says nothing about the reply — so a
// reply is pointed at the Sent folder, a draft at the draft itself. delete_draft
// reserves a draft's subject too, so an in-flight draft holder may be a delete.
export const reservationRefusal = (subject: SendSubject, held: SendReservation): string => {
  if (subject.tool === FORWARD_TOOL) {
    return held.state === 'in_flight'
      ? `A forward of ${subject.key} is already in progress. Nothing was sent by this call. Wait, then check ` +
          "the user's Sent folder to see whether it went out."
      : `An earlier forward of ${subject.key} failed without saying whether it went out, so it was NOT sent ` +
          "again — a second attempt could deliver a duplicate. Check the user's Sent folder before deciding."
  }
  if (subject.tool === REPLY_TOOL) {
    return held.state === 'in_flight'
      ? `A reply to ${subject.key} is already in progress. Nothing was sent by this call. Wait, then check ` +
          "the user's Sent folder to see whether it went out."
      : `An earlier reply to ${subject.key} failed without saying whether it went out, so it was NOT sent ` +
          "again — a second attempt could deliver a duplicate. Check the user's Sent folder before deciding."
  }
  return held.state === 'in_flight'
    ? `A send or delete of ${subject.key} is already in progress. Nothing was sent by this call. Wait, ` +
        'then read it back with get_draft — or get_email, if it is no longer a draft — to see what happened.'
    : `An earlier send of ${subject.key} failed without saying whether the message went out, so it was ` +
        'NOT sent again — a second attempt could deliver a duplicate. Read it back with get_email, or check ' +
        "the user's Sent folder, before deciding."
}

// The reservations one tool call holds, from its first step until it returns.
// Every subject it covers is settled together, exactly once, by `end`.
export interface SendHold {
  // Cover one more subject. Returns null when covered, or the reservation
  // another call holds on it.
  cover: (subject: SendSubject) => SendReservation | null
  // Settle: release every subject, unless delivery was marked unknown — then
  // they all stay blocked until the reservation expires.
  end: () => void
  // Delivery may have happened and the mailbox cannot be trusted to say so.
  markUnknown: () => void
}

// Take the first reservation of a call. Must run before the call's first read of
// the replay cache or the mailbox — see the header.
export const holdSend = (
  guard: SendGuard,
  principal: string,
  subject: SendSubject
): { hold: SendHold } | { refused: SendReservation } => {
  const owner = Symbol('send')
  const refused = guard.reserve(principal, subject, owner)
  if (refused) {
    return { refused }
  }
  const subjects = [subject]
  let unknown = false
  let ended = false
  return {
    hold: {
      cover: (next) => {
        const held = guard.reserve(principal, next, owner)
        if (!held) {
          subjects.push(next)
        }
        return held
      },
      end: () => {
        if (ended) {
          return
        }
        ended = true
        for (const s of subjects) {
          if (unknown) {
            guard.markUnknown(principal, s, owner)
          } else {
            guard.release(principal, s, owner)
          }
        }
      },
      markUnknown: () => {
        unknown = true
      },
    },
  }
}
