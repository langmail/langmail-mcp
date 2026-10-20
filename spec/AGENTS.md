# Send protocol spec

`SendProtocol.tla` is a TLA+ model of what stops `send_draft` and
`reply_to_message` from sending a message twice. Run `bun run spec:check`
from `services/mcp` to check it with TLC. You need Java 11+, and the first run
downloads a pinned `tla2tools.jar`. CI runs the same script
(`.github/workflows/tla.yml`).

## What it models

- **Clients.** Each request is one intention: send draft `d`, or reply to
  message `m`. A request can make up to three tool calls. `MCSendProtocol`
  checks one sender and one reply; `MCTwoSenders` checks two independent
  senders of the same draft, keyed differently or not at all. A client retries
  while its first call may still be running. An agent may also follow a
  failed reply's advice and `send_draft` the reply's staged draft.
- **Interleaving.** Calls interleave only at awaits that do I/O, because the
  event loop runs synchronous code to completion. One TLA+ step is the code
  between two such awaits.
- **Server.** Stalwart's `EmailSubmission/set` with `onSuccessUpdateEmail`,
  assumed to behave as badly as the RFC allows:
  - It can refuse any submission.
  - It delivers a message that is no longer a draft.
  - The patch that clears `$draft` can fail.
  - An answer can be lost while its request is still in flight and lands
    later.

## Properties

| Property | Meaning |
| --- | --- |
| `AtMostOncePerRequest` | One intention sends at most one message, however it was retried. |
| `AtMostOncePerEmail` | No Email reaches SMTP twice. |
| `TruthfulResults` | A result that says nothing was sent is true, even after a late request lands. |
| `NoLeakedReservation` | No return path leaves a reservation stuck `in_flight`. |
| `RetriesReplayed` | A keyed retry whose key already has a recorded answer gets that answer back. Holds by construction now; it guards the lookup-before-reserve order. |
| `CallsReturn` | Every call that starts eventually returns. |

The model does not cover three things. Nothing in the code prevents them:

- Reservations expire after 10 minutes and the replay cache after 15. A call
  that outlives its reservation cannot end a retry's: holds carry an owner.
- A restart clears both.
- A keyless reply may be retried after an earlier attempt returned "sent".
  Nothing can tell that apart from a deliberate second reply.

## What it found

The first model described the code as it was, and TLC found three
counterexamples:

1. **`send_draft` sent twice.** A retry read the draft as "still a draft"
   while the first call was in flight. The first call then finished and
   released its reservation. The retry reserved after that and submitted a
   message that had already gone. The fix: look up the replay and take the
   reservation in one synchronous step, before the draft is read. (The
   first version reserved before the lookup; see `RetriesReplayed` below
   for why the lookup has to come first.)
2. **`reply_to_message` sent twice with the same `idempotencyKey`.** The
   retry's replay lookup ran before the first call recorded its answer, and
   its reservation came after the first call released. It has the same fix.
3. **A reply reported as unsent that went out.** On a lost answer, the reply
   said it "could not be sent" and advised `send_draft` on its staged draft.
   The original submission could still land, so the advice could deliver a
   second copy. A reply now says delivery is unknown in that case. Its
   reservation also covers the staged draft under `send_draft`'s key, so
   that send is refused until the outcome is known.

`RetriesReplayed` was added after review and failed against the first fix.
That fix reserved before the replay lookup. After a send that was delivered
but left flagged `$draft`, a keyed retry was refused as "outcome unknown",
although the answer was already recorded under its key. The lookup now runs
first, in the same synchronous step as the reservation.

## Changing the protocol

Change the model first, run `./check.sh`, then change the code. The model's
steps map one-to-one to `sendDraft` and `replyToMessage`. If you move a
`holdSend`, an `await`, or `replays.record`, the model must move the same
way.
