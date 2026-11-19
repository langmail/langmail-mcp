---
type: reference
title: "timezones-ical-library upstream issues"
description: Index of timezones-ical-library defects we work around when writing VTIMEZONE components, and where to report them (GitHub issues on add2cal/timezones-ical-library). Read this before bumping timezones-ical-library.
owner: dominik
tags: [timezones-ical-library, calendar, timezone, upstream]
---

# timezones-ical-library upstream issues

Format and lifecycle: [`docs/upstream/AGENTS.md`](../AGENTS.md).

`timezones-ical-library` supplies the VTIMEZONE component for every zone an
event Langmail writes names (`vtimezoneComponent` in
`src/caldav/ical.ts`, passed to `ical-generator`). Its rules are
the tzdata release in its `package.json`'s `tzdataVersion`, so a zone's new
rules reach our events only through a bump. A defect here shows up in *other*
calendar clients as an event at the wrong time, not in Langmail, which reads
times by the IANA name.

It is pinned at `^3.0.0` in `package.json`.

## Reporting

GitHub issues on <https://github.com/add2cal/timezones-ical-library/issues>.

## Verification ledger

| Re-checked through | Date | Result |
|---|---|---|
| timezones-ical-library 3.0.0 (tzdata 2026f) | 2026-11-18 | Entries established; none reported upstream yet |

Re-check on every bump and add a row; retire satisfied entries in the same
commit. The `upstream:` tests in `src/caldav/ical.test.ts` turn
red when a defect is fixed, and the offset test there finds new ones.

## Entries

| File | Status | Observed | Workaround |
|---|---|---|---|
| [morocco-written-as-utc](morocco-written-as-utc.md) | open | 3.0.0 | Offsets rewritten to +0100 |
| [jerusalem-dst-start-last-friday](jerusalem-dst-start-last-friday.md) | open | 3.0.0 | RRULE rewritten to the Friday on the 23rd to 29th |
