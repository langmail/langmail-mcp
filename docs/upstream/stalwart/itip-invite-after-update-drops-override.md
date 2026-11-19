---
type: upstream
title: An invite that arrives after an instance update drops the update
description: Stalwart sends each iTIP message through its queue on its own, so when an organizer creates a series and changes one instance right away, the attendee can get the instance update (SEQUENCE:1, RECURRENCE-ID only) before the invite (SEQUENCE:0, the master). Ingesting the invite then replaces the attendee's copy, and the newer override is gone. The attendee's calendar shows the instance at its old time, and nothing reports it. The mcp control test waits for the invite to land before the organizer changes an instance. 1.0.2 fixes it in source; a live replay is pending before this file and the wait go.
status: filed
observed: 1.0.0
owner: dominik
tags: [stalwart, calendar, itip, imip, recurrence]
---

# An invite that arrives after an instance update drops the update

> **Fixed in source at 1.0.2, not yet verified live** (source read, 2026-11-03).
> 1.0.2's notes say "A full `REQUEST` with an older `SEQUENCE` no longer removes
> a newer override from the attendee's copy", and `crates/groupware/src/scheduling/inbound.rs`
> now removes a stored instance only when its `SEQUENCE` is not newer than the
> incoming master's. `inbound.rs` is byte-identical at 1.1.0; 1.1.1 changes it only for RSVP
> parameters and forwarded invitations, and the `SEQUENCE` guard is unchanged. Run the replay below on the pinned
> release, then delete this file and the test's wait.

## Observe

Stalwart 1.0.0, local attendees on the same server. The organizer PUTs a
weekly series for an attendee, then right away PUTs the same object with
one instance moved (an override with `RECURRENCE-ID`). Stalwart sends the
attendee two iMIP mails, each queued as its own message:

- the invite: `METHOD:REQUEST`, the master, `SEQUENCE:0`;
- the update: `METHOD:REQUEST`, only the moved instance, `SEQUENCE:1`.

The two can be delivered in either order. Replaying the two captured
payloads over authenticated submission (the organizer as sender) to fresh
attendees, 2 s apart, on a fresh `stalwartlabs/stalwart:v1.0.0` container,
2026-10-28, three runs each:

| Order | Attendee's copy afterwards |
|---|---|
| invite, then update | master + the moved instance (3 of 3) |
| update, then invite | master only, the moved instance is gone (3 of 3) |

Both mails land in the Inbox with `X-Spam-Status: No` in both orders, so
the iTIP ingest runs for each. Applying the invite replaces the stored
object instead of keeping the override, whose `SEQUENCE` is higher. This
comes from the observed behaviour; the merge code was not read.

In CI it is the `control: REPLYs for an instance the organizer already
overrode both land` test in
`src/caldav/stalwart-reply-unmodified-instance.test.ts`, red
in 4 of about 16 runs on the 1.0 cutover branch: attendee A had the series
but never the moved instance, 30 s after the organizer moved it. Main, on
0.16.27, never failed it. 0.16 also sends iMIP through the task manager
and the queue (`crates/services/src/task_manager/imip.rs` at `v0.16.27`, `task_manager/tasks/imip.rs` from 1.0); whether its
ingest drops the override too was not tested.

## Why it matters

RFC 5546 §2.1.5 orders revisions by `SEQUENCE`, and a component that is
older than the stored one should not replace it. Here a newer change is lost
for good: the attendee's calendar shows the instance at its old time, the
organizer's copy shows the new one, and no one is told. It needs an
organizer who creates a series and changes an instance within the delivery
window, which an agent through the MCP tools can do in two calls. It also
applies to iMIP from outside, where SMTP gives no ordering either.

## Workaround

- The control test waits for each attendee to hold the series before the
  organizer moves the instance, so the invite is ingested before the update
  exists.
- Production: none. The owner accepted the risk for the 1.0 cutover on
  2026-10-29 (migration plan, question 9;
  langmail/platform, `git show 889492415:docs/proposals/2026-10-28-stalwart-1-0-migration/plan.md`).

## Upstream

Filed 2026-10-28 by the owner: [t/2096 "v1.0.0: An invite delivered after
an instance update drops the update from the attendee's copy"][t2096],
after searching the portal (`itip sequence override`, `recurring instance
update lost`, `iMIP out of order`; topic 1192 is a different defect, an
ingest that never ran) and GitHub issues. Proposed fix: when ingesting a
REQUEST for a UID the attendee already has, keep stored overrides whose
`SEQUENCE` is higher than the incoming master's, or deliver one
organizer's iTIP messages to a recipient in the order they were sent.

[t2096]: https://support.stalw.art/t/v1-0-0-an-invite-delivered-after-an-instance-update-drops-the-update-from-the-attendees-copy/2096

## Drop workaround when

A release keeps the override when the invite arrives second. Verify by
capturing the invite and the instance update one attendee received,
re-sending them to a new attendee update first over authenticated
submission, and checking that the attendee's copy has both the master and
the moved instance. The test's wait can then go.
