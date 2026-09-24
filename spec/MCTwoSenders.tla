----------------------------- MODULE MCTwoSenders -----------------------------
\* Model for TLC: two independent send_draft requests for the same draft, each
\* with up to three calls — two agents, or one agent that lost track of its
\* first request. Whether each passes an idempotencyKey is chosen in Init, so
\* both keyless, one keyed, and two different keys are all checked. No reply,
\* so no fresh drafts are staged.
EXTENDS SendProtocol

CONSTANTS d1, m1, rSend, rSend2

MCTarget == [r \in {rSend, rSend2} |-> d1]
MCTries == [r \in {rSend, rSend2} |-> 3]
=============================================================================
