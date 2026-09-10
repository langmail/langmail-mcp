// MCP tool annotations for this surface, as five named risk classes.
//
// The point of annotating every tool rather than a few is that a client can
// then decide which calls need a confirmation step *from the annotations
// alone*, without hard-coding tool names — which is the only version of that
// check that survives new tools being added.
//
// Two hints carry the decision, and this surface uses them with fixed meanings:
//
//   openWorldHint    the call reaches someone outside the user's own account —
//                    a recipient, an attendee, an iMIP notice.
//   destructiveHint  the call cannot be taken back from here: it removes
//                    something, or it hands something to a third party.
//
// Staging is deliberately distinguishable from sending on those two alone:
// create_draft is ACCOUNT_WRITE (nobody outside the mailbox sees it, the user
// can delete it), send_draft is OUTWARD_DESTRUCTIVE. That is the whole
// asymmetry the sending surface rests on, expressed where a client can read it.
//
// `idempotentHint` stays false on every write. The composition tools accept an
// `idempotencyKey` that does make a retry safe, but the hint describes the tool
// unconditionally and a caller that omits the key gets a second send — so
// claiming idempotence here would be a lie in exactly the case it matters.

export interface ToolRiskAnnotations {
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
  readOnlyHint: boolean
}

// Reads nothing but the user's own data back to them.
export const READ_ONLY: ToolRiskAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
}

// Writes inside the user's own account. No third party learns anything and the
// user can undo it in the UI — staging a draft, creating a calendar, adding a
// mail rule.
export const ACCOUNT_WRITE: ToolRiskAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
}

// Removes something from the user's own account. Still nobody outside sees it,
// but this surface cannot undo it — a deleted rule is gone, an edited draft
// is replaced, trashed mail is recoverable only from the mail client until
// Trash is emptied.
export const ACCOUNT_DESTRUCTIVE: ToolRiskAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
}

// Third parties are notified, but nothing is destroyed — an invitation, an RSVP.
//
// The mail-rule writers live here rather than under ACCOUNT_WRITE because a rule
// may carry a `forward` action, which redirects a copy of every matching future
// message to an arbitrary address. A static annotation has to describe what the
// tool *can* do, and "quietly installs a persistent data-forwarding rule" is the
// most consequential outward reach on this surface — a client gating on
// `openWorldHint` has to see it.
export const OUTWARD_WRITE: ToolRiskAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
}

// Irreversible and visible outside the account: mail is delivered, a meeting is
// cancelled, attendees are notified. These are the calls worth confirming.
export const OUTWARD_DESTRUCTIVE: ToolRiskAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
}
