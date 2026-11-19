---
type: reference
title: "@date-fns/tz upstream issues"
description: Index of @date-fns/tz defects we carry consequences for, and where to report them (GitHub issues on date-fns/tz). Read this before bumping @date-fns/tz.
owner: dominik
tags: [date-fns-tz, calendar, timezone, upstream]
---

# @date-fns/tz upstream issues

Format and lifecycle: [`docs/upstream/AGENTS.md`](../AGENTS.md).

`@date-fns/tz` supplies `TZDate`, which is how every calendar time in this
repository moves between an instant and a wall clock in an IANA zone:
`parseWallClockInZone` in `src/ical/timezone.ts` and
`toZonedDate` / `toWallClockIso` in `src/caldav/timezone.ts` are
all thin wrappers over it. A defect here therefore surfaces as a calendar
event landing on the wrong instant, not as a crash.

It is pinned at `^1.5.0` in `package.json`.

## Reporting

GitHub issues on <https://github.com/date-fns/tz/issues>.

## Verification ledger

Findings were established on the `observed` version in each file's
frontmatter. Since then, releases have been re-checked for every entry's
"Drop workaround when" clause:

| Re-checked through | Date | Result |
|---|---|---|
| @date-fns/tz 1.5.0 | 2026-10-31 | No drop clause satisfied. Upstream date-fns/tz#13 is still open, and a comment on it reproduces the system-zone dependence on 1.4.1 and 1.5.0 |

Re-check on every bump of `@date-fns/tz` and add a row; retire satisfied
entries in the same commit.

## Entries

| File | Status | Observed | Workaround |
|---|---|---|---|
| [ambiguous-wall-clock-depends-on-system-zone](ambiguous-wall-clock-depends-on-system-zone.md) | filed — upstream issue open | @date-fns/tz 1.5.0 | None in product code; the test for the ambiguous hour asserts the weaker of two claims |
