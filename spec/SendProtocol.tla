--------------------------- MODULE SendProtocol ---------------------------
(***************************************************************************)
(* The duplicate-send protocol behind the MCP tools `send_draft` and       *)
(* `reply_to_message` (services/mcp/src/tools/send-draft.ts,               *)
(* reply-to-message.ts, drafts/send-guard.ts, drafts/idempotency.ts).      *)
(*                                                                         *)
(* A client *request* is one intention: "send draft d" or "reply to m".    *)
(* It may produce several *attempts* (tool calls): a client that times     *)
(* out retries while the first call may still be running, and an agent    *)
(* may follow a result's advice and send the draft a failed reply staged.  *)
(* Attempts interleave only at awaits that do I/O, which is where the JS   *)
(* event loop lets another call run; a step below is the synchronous code  *)
(* between two such awaits.                                                *)
(*                                                                         *)
(* The server is Stalwart's EmailSubmission/set with onSuccessUpdateEmail  *)
(* (services/mcp/src/jmap/submission.ts). Worst case throughout: it may    *)
(* refuse any submission, it delivers a message whether or not it is       *)
(* still a draft (RFC 8621 does not require $draft), the follow-up patch   *)
(* that clears $draft may fail, and any answer may be lost. A request may  *)
(* sit on the wire and land after the client gave up on it.                *)
(*                                                                         *)
(* Out of scope: reservation and replay-cache expiry (10 and 15 minutes)   *)
(* and a process restart, both of which reopen the window by design; and  *)
(* a keyless reply retried after an earlier attempt returned "sent", which *)
(* nothing can tell apart from a deliberate second reply.                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Drafts,       \* drafts already staged, the targets of send_draft requests
    Originals,    \* received messages, the targets of reply_to_message requests
    Fresh,        \* ids Email/set can mint for the drafts replies stage
    Requests,
    Target,       \* [Requests -> Drafts \cup Originals]
    Tries,        \* [Requests -> Nat]: tool calls per request, the first plus its retries
    None

ASSUME Target \in [Requests -> Drafts \cup Originals]
ASSUME Tries \in [Requests -> Nat \ {0}]

Emails == Drafts \cup Originals \cup Fresh
Attempts == UNION {{r} \X (1 .. Tries[r]) : r \in Requests}
Req(a) == a[1]
Prev(a) == <<a[1], a[2] - 1>>
Earlier(a) == {<<a[1], j>> : j \in 1 .. (a[2] - 1)}

\* drafts/send-guard.ts keys a reservation by tool and a retry-stable id.
Subjects == ({"send_draft"} \X (Drafts \cup Fresh)) \cup ({"reply_to_message"} \X Originals)

\* Tool results, by what they tell the agent.
SentResults == {"sent", "sent_unfiled"}
NothingSentResults ==                       \* each says: this call sent nothing
    {"replayed", "not_found", "already_sent", "refused_in_flight",
     "refused_unknown", "rejected", "reply_rejected"}
UnknownResults == {"unknown", "reply_unknown"}  \* each says: it may have gone out

VARIABLES
    hasKey,     \* [Requests -> BOOLEAN]: does the client pass an idempotencyKey
    email,      \* [Emails -> {"absent", "draft", "sent", "received"}]
    guard,      \* [Subjects -> {"free", "in_flight", "unknown"}]
    replays,    \* [Requests -> BOOLEAN]: replay recorded under the request's key
    pc,         \* [Attempts -> step]
    tool,       \* [Attempts -> tool the attempt calls]
    draft,      \* [Attempts -> the Email the attempt submits, or None]
    held,       \* [Attempts -> SUBSET Subjects]: the attempt's SendHold
    unknown,    \* [Attempts -> BOOLEAN]: SendHold.markUnknown was called
    net,        \* submissions on the wire, not yet processed by the server
    answer,     \* [Attempts -> server answer to the attempt's submission]
    result,     \* [Attempts -> the tool result]
    advice,     \* [Attempts -> draft the result says to send_draft, or None]
    delivered,  \* [Emails -> Nat]: copies handed to SMTP
    sentBy,     \* [Attempts -> BOOLEAN]: the attempt's submission was delivered
    seen        \* [Attempts -> BOOLEAN]: a replay was recorded when it started

vars == <<hasKey, email, guard, replays, pc, tool, draft, held, unknown,
          net, answer, result, advice, delivered, sentBy, seen>>

TypeOK ==
    /\ hasKey \in [Requests -> BOOLEAN]
    /\ email \in [Emails -> {"absent", "draft", "sent", "received"}]
    /\ guard \in [Subjects -> {"free", "in_flight", "unknown"}]
    /\ replays \in [Requests -> BOOLEAN]
    /\ held \in [Attempts -> SUBSET Subjects]
    /\ unknown \in [Attempts -> BOOLEAN]
    /\ answer \in [Attempts -> {"none", "rejected", "filed", "unfiled"}]
    /\ delivered \in [Emails -> Nat]
    /\ sentBy \in [Attempts -> BOOLEAN]
    /\ seen \in [Attempts -> BOOLEAN]

Init ==
    /\ hasKey \in [Requests -> BOOLEAN]
    /\ email = [e \in Emails |-> IF e \in Drafts THEN "draft"
                                 ELSE IF e \in Originals THEN "received"
                                 ELSE "absent"]
    /\ guard = [s \in Subjects |-> "free"]
    /\ replays = [r \in Requests |-> FALSE]
    /\ pc = [a \in Attempts |-> "idle"]
    /\ tool = [a \in Attempts |-> "none"]
    /\ draft = [a \in Attempts |-> None]
    /\ held = [a \in Attempts |-> {}]
    /\ unknown = [a \in Attempts |-> FALSE]
    /\ net = {}
    /\ answer = [a \in Attempts |-> "none"]
    /\ result = [a \in Attempts |-> "none"]
    /\ advice = [a \in Attempts |-> None]
    /\ delivered = [e \in Emails |-> 0]
    /\ sentBy = [a \in Attempts |-> FALSE]
    /\ seen = [a \in Attempts |-> FALSE]

-----------------------------------------------------------------------------
(* The client.                                                             *)

\* A retry may start once the attempt before it has. A keyless reply retried
\* after an earlier attempt returned "sent" is left out: see the header.
MayStart(a) ==
    /\ pc[a] = "idle"
    /\ \/ a[2] = 1
       \/ /\ a[2] > 1
          /\ pc[Prev(a)] # "idle"
          /\ \/ hasKey[Req(a)]
             \/ Target[Req(a)] \in Drafts
             \/ \A b \in Earlier(a) : result[b] \notin SentResults

\* Only the request's own tool call carries its key. A send_draft an agent
\* makes on a reply's advice is a different tool, and keys are per tool.
Keyed(a) ==
    /\ hasKey[Req(a)]
    /\ tool[a] = IF Target[Req(a)] \in Drafts THEN "send_draft" ELSE "reply_to_message"

-----------------------------------------------------------------------------
(* SendHold (drafts/send-guard.ts).                                        *)

\* guard' after ending a's hold: release everything, or keep it all blocked.
EndHold(a) ==
    [s \in Subjects |-> IF s \in held[a]
                        THEN IF unknown[a] THEN "unknown" ELSE "free"
                        ELSE guard[s]]

Finish(a, res) ==
    /\ pc' = [pc EXCEPT ![a] = "done"]
    /\ result' = [result EXCEPT ![a] = res]

\* End the call: settle the hold (the `finally` around both tools) and return.
Return(a, res) ==
    /\ guard' = EndHold(a)
    /\ Finish(a, res)

Refusal(s) == IF guard[s] = "in_flight" THEN "refused_in_flight" ELSE "refused_unknown"

-----------------------------------------------------------------------------
(* The tools. Each starts with one synchronous step, before its first     *)
(* await: the replay lookup, then holdSend.                                *)

Start(a, t, d, s) ==
    /\ tool' = [tool EXCEPT ![a] = t]
    /\ draft' = [draft EXCEPT ![a] = d]
    /\ seen' = [seen EXCEPT ![a] = replays[Req(a)]]
    /\ LET keyed == hasKey[Req(a)] /\ t = IF Target[Req(a)] \in Drafts
                                           THEN "send_draft" ELSE "reply_to_message"
       IN IF keyed /\ replays[Req(a)]
          THEN /\ Finish(a, "replayed")
               /\ UNCHANGED <<guard, held>>
          ELSE IF guard[s] # "free"
          THEN /\ Finish(a, Refusal(s))
               /\ UNCHANGED <<guard, held>>
          ELSE /\ held' = [held EXCEPT ![a] = {s}]
               /\ guard' = [guard EXCEPT ![s] = "in_flight"]
               /\ pc' = [pc EXCEPT ![a] = IF t = "send_draft" THEN "load" ELSE "stage"]
               /\ UNCHANGED result

StartSendDraft(a, d) == Start(a, "send_draft", d, <<"send_draft", d>>)

StartAttempt(a) ==
    /\ MayStart(a)
    /\ LET r == Req(a) IN
       \/ Target[r] \in Drafts /\ StartSendDraft(a, Target[r])
       \/ /\ Target[r] \in Originals
          /\ \A b \in Earlier(a) : tool[b] # "send_draft"
          /\ Start(a, "reply_to_message", None, <<"reply_to_message", Target[r]>>)
       \* An agent acting on the latest answer: send the draft a failed reply
       \* named as safe to send, or retry that send_draft.
       \/ /\ Target[r] \in Originals
          /\ a[2] > 1
          /\ \E x \in {advice[Prev(a)]} \cup
                      (IF tool[Prev(a)] = "send_draft" THEN {draft[Prev(a)]} ELSE {}) :
                /\ x # None
                /\ StartSendDraft(a, x)
    /\ UNCHANGED <<hasKey, email, replays, unknown, net, answer, advice, delivered, sentBy>>

\* send_draft: loadSendableDraft reads the draft inside the hold.
Load(a) ==
    /\ pc[a] = "load"
    /\ CASE email[draft[a]] = "absent" -> Return(a, "not_found")
         [] email[draft[a]] = "draft"  -> pc' = [pc EXCEPT ![a] = "submit"]
                                          /\ UNCHANGED <<guard, result>>
         [] OTHER                      -> Return(a, "already_sent")
    /\ UNCHANGED <<hasKey, email, replays, tool, draft, held, unknown, net, answer,
                   advice, delivered, sentBy, seen>>

\* reply_to_message: Email/set creates the reply as a draft; the hold then
\* covers it under send_draft's subject.
Stage(a) ==
    /\ pc[a] = "stage"
    /\ \E f \in Fresh :
         /\ email[f] = "absent"
         /\ \A b \in Attempts : draft[b] # f
         /\ email' = [email EXCEPT ![f] = "draft"]
         /\ draft' = [draft EXCEPT ![a] = f]
         /\ LET s == <<"send_draft", f>> IN
            IF guard[s] # "free"
            THEN /\ Return(a, Refusal(s))
                 /\ UNCHANGED held
            ELSE /\ held' = [held EXCEPT ![a] = @ \cup {s}]
                 /\ guard' = [guard EXCEPT ![s] = "in_flight"]
                 /\ pc' = [pc EXCEPT ![a] = "submit"]
                 /\ UNCHANGED result
    /\ UNCHANGED <<hasKey, replays, tool, unknown, net, answer, advice, delivered, sentBy, seen>>

\* submitDraft hands the submission to the wire.
Submit(a) ==
    /\ pc[a] = "submit"
    /\ net' = net \cup {[att |-> a, email |-> draft[a]]}
    /\ pc' = [pc EXCEPT ![a] = "wait"]
    /\ UNCHANGED <<hasKey, email, guard, replays, tool, draft, held, unknown, answer,
                   result, advice, delivered, sentBy, seen>>

\* The answer arrives. The replay is recorded before the hold ends, in the same
\* step: a retry that gets the reservation always finds it.
Receive(a) ==
    /\ pc[a] = "wait"
    /\ answer[a] # "none"
    /\ LET record == IF Keyed(a) THEN [replays EXCEPT ![Req(a)] = TRUE] ELSE replays
           replyRejected == tool[a] = "reply_to_message"
       IN CASE answer[a] = "rejected" ->
                 \* JmapError with a type: the server said no. Nothing was sent.
                 /\ replays' = replays
                 /\ unknown' = unknown
                 /\ guard' = EndHold(a)
                 /\ Finish(a, IF replyRejected THEN "reply_rejected" ELSE "rejected")
                 /\ advice' = IF replyRejected THEN [advice EXCEPT ![a] = draft[a]] ELSE advice
            [] answer[a] = "filed" ->
                 /\ replays' = record
                 /\ unknown' = unknown
                 /\ guard' = EndHold(a)
                 /\ Finish(a, "sent")
                 /\ UNCHANGED advice
            [] answer[a] = "unfiled" ->
                 \* Delivered, but still flagged $draft: the hold stays.
                 /\ replays' = record
                 /\ unknown' = [unknown EXCEPT ![a] = TRUE]
                 /\ guard' = [s \in Subjects |-> IF s \in held[a] THEN "unknown" ELSE guard[s]]
                 /\ Finish(a, "sent_unfiled")
                 /\ UNCHANGED advice
    /\ UNCHANGED <<hasKey, email, tool, draft, held, net, answer, delivered, sentBy, seen>>

\* Timeout, reset, a proxy 502, or an answer lost on the way back: delivery
\* unknown. The request itself may still be on the wire.
Lose(a) ==
    /\ pc[a] = "wait"
    /\ unknown' = [unknown EXCEPT ![a] = TRUE]
    /\ guard' = [s \in Subjects |-> IF s \in held[a] THEN "unknown" ELSE guard[s]]
    /\ Finish(a, IF tool[a] = "reply_to_message" THEN "reply_unknown" ELSE "unknown")
    /\ UNCHANGED <<hasKey, email, replays, tool, draft, held, net, answer, advice,
                   delivered, sentBy, seen>>

-----------------------------------------------------------------------------
(* The server.                                                             *)

Process(m) ==
    /\ net' = net \ {m}
    /\ \/ /\ answer' = [answer EXCEPT ![m.att] = "rejected"]
          /\ UNCHANGED <<email, delivered, sentBy, seen>>
       \/ /\ delivered' = [delivered EXCEPT ![m.email] = @ + 1]
          /\ sentBy' = [sentBy EXCEPT ![m.att] = TRUE]
          /\ \/ /\ email' = [email EXCEPT ![m.email] = "sent"]
                /\ answer' = [answer EXCEPT ![m.att] = "filed"]
             \/ /\ UNCHANGED email
                /\ answer' = [answer EXCEPT ![m.att] = "unfiled"]
    /\ UNCHANGED <<hasKey, guard, replays, pc, tool, draft, held, unknown, result, advice, seen>>

-----------------------------------------------------------------------------

Step(a) == Load(a) \/ Stage(a) \/ Submit(a) \/ Receive(a) \/ Lose(a)

Running(a) == pc[a] \notin {"idle", "done"}

\* Everything that started has returned and the wire is empty.
Quiescent == (\A a \in Attempts : ~Running(a)) /\ net = {}

Next ==
    \/ \E a \in Attempts : StartAttempt(a) \/ Step(a)
    \/ \E m \in net : Process(m)
    \/ Quiescent /\ UNCHANGED vars

\* A call keeps making progress, and the server eventually answers what
\* reaches it. Attempts need not start: a client may stop retrying.
Fairness ==
    /\ \A a \in Attempts : WF_vars(Step(a))
    /\ \A m \in [att : Attempts, email : Emails] : WF_vars(m \in net /\ Process(m))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties.                                                             *)

Deliveries(r) == Cardinality({a \in Attempts : Req(a) = r /\ sentBy[a]})

\* One intention, at most one message out — however it was retried.
AtMostOncePerRequest == \A r \in Requests : Deliveries(r) <= 1

\* No Email is handed to SMTP twice, across all requests.
AtMostOncePerEmail == \A e \in Emails : delivered[e] <= 1

\* A result that says nothing was sent is true, even after a request still on
\* the wire lands. And "sent" is only said of a delivery.
TruthfulResults ==
    \A a \in Attempts :
        /\ result[a] \in NothingSentResults => ~sentBy[a]
        /\ result[a] \in SentResults => sentBy[a]

\* A subject is only in flight while a running call holds it: no reservation
\* is leaked by a path that returns without ending its hold.
NoLeakedReservation ==
    \A s \in Subjects :
        guard[s] = "in_flight" => \E a \in Attempts : Running(a) /\ s \in held[a]

\* A retry carrying a key that already has an answer gets that answer back —
\* whatever state the reservation was left in. With the lookup first in Start
\* this holds by construction; it is a regression guard that fails the moment
\* Start reserves before the lookup, as an earlier fix did after an unfiled send.
RetriesReplayed ==
    \A a \in Attempts :
        (pc[a] = "done" /\ Keyed(a) /\ seen[a]) => result[a] = "replayed"

\* Every call that starts returns.
CallsReturn == \A a \in Attempts : (pc[a] # "idle") ~> (pc[a] = "done")

\* Non-vacuity: TLC is run once with this as an invariant and must find it
\* violated, proving that a message can be sent at all in the model.
NothingEverSent == \A e \in Emails : delivered[e] = 0

=============================================================================
