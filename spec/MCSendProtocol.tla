---------------------------- MODULE MCSendProtocol ----------------------------
\* Model for TLC: one send_draft request and one reply_to_message request, each
\* with up to three calls. Whether each passes an idempotencyKey is chosen in
\* Init, so every combination is checked. MCTwoSenders covers two independent
\* requests for one draft; the three together are too large for CI.
EXTENDS SendProtocol

CONSTANTS d1, m1, f1, f2, f3, rSend, rReply

MCTarget == [r \in {rSend, rReply} |-> IF r = rSend THEN d1 ELSE m1]
MCTries == [r \in {rSend, rReply} |-> 3]
=============================================================================
