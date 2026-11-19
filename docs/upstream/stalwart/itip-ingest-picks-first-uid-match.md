---
type: upstream
title: With one UID in two calendars, an incoming iTIP update reaches only one copy
description: Stalwart enforces UID uniqueness per calendar, not per account, but its iTIP ingestion looks a UID up account-wide and updates the first match only. When a client has left the same event in two calendars, an organizer's update or an attendee's reply silently skips the other copy, which keeps showing the old state. No workaround exists; a proposed move_calendar_events tool would refuse to create the duplicate and surface it as `ambiguous`.
status: open
observed: 0.16.23
owner: dominik
tags: [stalwart, caldav, calendar, imip, itip]
---

# With one UID in two calendars, an incoming iTIP update reaches only one copy

## Observe

CalDAV scopes UID uniqueness to a calendar collection: RFC 4791 §5.3.2.1 defines
the `no-uid-conflict` precondition per collection, so a principal may hold the
same UID in two of their calendars. Stalwart 0.16.23 follows that. A `PUT` of
an event whose UID already exists in another calendar of the same account
answers `201 Created`, and `assert_is_unique_uid` in
`crates/dav/src/calendar/mod.rs` checks only the target collection's children.

Scheduling does not follow the same scope. `itip_ingest` in
`crates/groupware/src/calendar/itip.rs` at `v0.16.23` resolves the incoming
message's UID across the whole account and takes the first document it finds
(both that file and `crates/dav/src/calendar/mod.rs` are byte-identical at
`v0.16.24`, re-read 2026-09-29, at `v0.16.25`, re-read 2026-10-06, and at
`v0.16.26`, re-read 2026-10-13; at `v0.16.27`, re-read 2026-10-20, `mod.rs` is
byte-identical and `itip.rs` changed only the `itip_merge_changes` call, not the
lookup below):

```rust
// crates/groupware/src/calendar/itip.rs @ v0.16.23
let document_id = self
    .document_ids_matching(account_id, Collection::CalendarEvent,
                           CalendarEventField::Uid, itip_snapshots.uid.as_bytes())
    .await?
    .iter()
    .next();
```

Only that document is updated. The other copy is not touched and nothing
reports that it exists.

This was reproduced live against the dev compose on 0.16.23. A local organizer
invited a local attendee, and Stalwart filed the invitation in the attendee's
default calendar. The attendee then wrote a byte-identical copy of that
invitation into a second calendar, which Stalwart accepted. When the organizer
renamed the event, the attendee's default-calendar copy carried the new title
and the second copy kept the old one:

```text
copies after the organizer's update
  [{"summary":"Review (moved to Friday)", "where":"default"},
   {"summary":"Review",                   "where":"Private"}]
```

Which copy wins is decided by document-id order, not by anything the user
chose. In this reproduction the older document won; nothing in the code
guarantees that.

## Why it matters

The duplicate is easy to create without meaning to. A second client importing
an `.ics` attachment, a user copying an event between calendars in a client
that implements copy as `PUT`, or an import that runs twice all produce it.
From then on, every update to that meeting silently reaches only one copy.
The stale copy still shows the old time or place, and a user who looks at the
wrong calendar goes to the wrong meeting. On the organizer side, an attendee's
`REPLY` updates one copy's `PARTSTAT`, so the other shows a stale attendee list.

Nothing signals the divergence. Both copies answer every CalDAV query
correctly, and no log line at the default level mentions the skipped document.

## Workaround

None. The behaviour is inside Stalwart's scheduling path, and nothing in this
repository changes it.

A proposed `move_calendar_events` MCP tool, currently a draft, would avoid
creating the state and make it visible where it exists. A move
into a calendar that already holds the UID is refused by Stalwart with
`no-uid-conflict` and would be reported as `uidConflict`, and a UID found in more than
one source calendar would be reported as `ambiguous` rather than guessed, with
a `fromCalendar` argument to resolve it. When the tool ships, replace this
paragraph with a pointer to its source file; until then it describes a design,
not code.

## Upstream

Not filed yet. The report should argue consistency, not legality: storing the
duplicate is permitted, and the defect is that scheduling then treats a
collection-scoped identity as account-scoped and drops all but one match
without saying so.

Proposed fix, in order of preference: apply the incoming message to every
document in the account whose UID matches, since each is a copy of the same
scheduling object; or, failing that, log the skipped documents at `warn` so
the divergence is at least observable.

## Drop workaround when

There is no workaround to drop. The entry retires when an incoming update
reaches every copy of a duplicated UID, or when Stalwart refuses to store the
duplicate in the first place.

Verify with `src/caldav/stalwart-duplicate-uid-itip.test.ts`,
which runs in the Stalwart e2e CI job. It asserts that exactly one of the two
copies carries the update, so it turns red when either fix lands.
