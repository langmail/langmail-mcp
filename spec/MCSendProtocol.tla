---------------------------- MODULE MCSendProtocol ----------------------------
\* Model for TLC: one send_draft request and one reply_to_message request, each
\* with up to three calls. Whether each passes an idempotencyKey is chosen in
\* Init, so every combination is checked.
EXTENDS SendProtocol

CONSTANTS d1, m1, f1, f2, f3, rSend, rReply

MCTarget == [r \in {rSend, rReply} |-> IF r = rSend THEN d1 ELSE m1]
=============================================================================
