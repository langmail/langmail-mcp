---
type: upstream
title: An ambiguous wall-clock time resolves to a different instant depending on the host's own time zone
description: TZDate resolves a wall clock that occurs twice in its zone using the host process's zone, so the same calendar input yields two different instants on two machines; we cannot assert the exact instant in tests, and a deployment that changes TZ would change which instant an event gets.
status: filed
observed: 1.5.0
owner: dominik
tags: [date-fns-tz, calendar, timezone, dst]
---

# An ambiguous wall-clock time resolves differently per host zone

## Observe

On the autumn fall-back day a wall clock occurs twice in its zone. Berlin
moves +02:00 → +01:00 on 2026-10-25, so `02:30` happens at both
`00:30Z` and `01:30Z`. Which one `TZDate` picks depends on the time zone of
the *host process*, not only on the zone it was asked about.

With `@date-fns/tz` 1.5.0, via `parseWallClockInZone`
(`src/ical/timezone.ts`):

| Host `TZ` | `resolveInputDateTime('2026-10-25T02:30:00', 'Europe/Berlin', false)` |
|---|---|
| `UTC` | `02:30+01:00` → **01:30Z** |
| `Europe/Berlin` | `02:30+02:00` → **00:30Z** |
| `Asia/Kolkata` | `02:30+02:00` → **00:30Z** |
| `America/Anchorage` | `02:30+01:00` → **01:30Z** |
| `Australia/Lord_Howe` | `02:30+02:00` → **00:30Z** |

Asia/Kolkata has no daylight saving of its own, so this is the host's
*offset* leaking into the decision rather than its own DST rules.

The neighbouring case — a wall clock that does **not** exist, `02:30` on the
spring-forward day 2026-03-29 — is stable across all the host zones checked,
resolving forward to `01:30Z` (`03:30+02:00`). Only the ambiguous direction
varies.

## Why it matters

`resolveInputDateTime` is how both calendar-write tools read a caller's
`start`/`end` (`src/tools/create-calendar-event.ts`,
`src/tools/update-calendar-event.ts`). An event created for
02:30 on the fall-back day therefore lands on an instant chosen partly by the
host's `TZ`, so two differently configured hosts disagree by an hour on the
same request.

### The zone the MCP service actually runs in

Today that zone is **UTC**, and only by accident of the base image:

- `infra/modules/base.nix` in langmail/platform sets `time.timeZone = "Europe/Berlin"` for the VM.
- `infra/modules/mcp.nix` in langmail/platform sets no `TZ` in its `environment` and mounts no
  `/etc/localtime`, so the container does **not** inherit the host's Berlin
  zone. It runs the `oven/bun:1.4.4-slim` default
  (`Dockerfile`), which is UTC.

So nothing states the zone this behaviour depends on. Adding `TZ=Europe/Berlin`
to that `environment` block — an obvious thing to do for readable log
timestamps — would move the ambiguous hour from `01:30Z` to `00:30Z`, per the
table above: an hour-wide window of calendar times shifting once a year, with
no other visible cause. Treat `TZ` on that container as a calendar-affecting
setting, not a formatting one.

### It is not only the write path

`parseWallClockInZone` also reads *stored* VEVENT times and recurrence
bookkeeping back, so a host zone that changes between a write and a later read
moves times that were already correct:

| Call site | Reads |
|---|---|
| `src/ical/ical-parse.ts:342`, `:415` | `DTSTART`/`DTEND` carrying a `TZID` |
| `src/caldav/occurrence.ts:112`, `:240` | an occurrence's start and its `RECURRENCE-ID` |
| `src/caldav/recurrence.ts:135`, `:296` | `UNTIL` end-of-day, `EXDATE` and override wall clocks |
| `src/caldav/agenda.ts:124` | the agenda window bounds |

A *consistent* host zone keeps write and read on the same side of the fold, so
occurrence matching still works. The exposure is a host zone that changes
between them, or two differently configured hosts reading the same calendar.

It also means no test can assert the exact instant for an ambiguous wall
clock without pinning itself to the runner's zone.

## Workaround

None in product code: picking a side ourselves would mean reimplementing the
zone arithmetic we use this dependency for, and the exposure is narrow.

The consequence we carry is in the test. `src/caldav/timezone.test.ts`,
in `resolves a wall clock that happens twice to one of its two instants`,
asserts only that the result is *one of* the two valid instants, where every
other case in that file pins an exact value.

The hazard is also named where it would be triggered: the `environment` block
in `infra/modules/mcp.nix` carries a comment saying why there is no `TZ` there
and pointing back at this file, so adding one for log timestamps is a decision
rather than an accident. `AGENTS.md`'s Configuration table does
not list `TZ`; whether to add a row there is an open question for the
maintainer, raised on <https://github.com/langmail/platform/pull/976>.

## Upstream

Tracked as <https://github.com/date-fns/tz/issues/13> ("Hours shift when
creating TZDate on a DST transition date"), which is open. It was reported for
a different surface — construction on a transition date — but the root cause
is the same: `TZDate` consults the system zone while building the date. A
comment on that issue reports the behaviour still reproducing on 1.4.1 and
1.5.0, against an earlier claim that 1.1.1 had fixed it.

The fix we would want is the one proposed on that thread: resolve an
ambiguous local time to a fixed side (the earlier instant, as a native `Date`
does) and advance a nonexistent one, both independent of the host zone.

Our evidence above is not yet on that thread, and adding it needs a human
account: <https://github.com/langmail/platform/issues/977> owns that step
(`ready-for-human`). If it is closed as not planned, this drop clause is judged
from release notes alone.

## Drop workaround when

A `@date-fns/tz` release states that ambiguous local times resolve
independently of the system time zone, or date-fns/tz#13 closes as fixed.
Verify by running `src/caldav/timezone.test.ts` under two host
zones that disagree today — `TZ=UTC` and `TZ=Asia/Kolkata` — and checking
that both give the same instant for `2026-10-25T02:30:00` in Europe/Berlin.
Then tighten that test to assert the exact instant and delete this file.
