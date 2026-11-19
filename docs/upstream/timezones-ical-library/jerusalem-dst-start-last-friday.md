---
type: upstream
title: Israeli summer time starts on the last Friday of March, a week late in some years
description: The library writes Asia/Jerusalem's daylight onset as the last Friday of March, but Israel's rule is the Friday before the last Sunday (the 23rd to 29th); in years like 2028 other clients would show events in that week an hour off, so we rewrite the RRULE.
status: open
observed: 3.0.0
owner: dominik
tags: [timezones-ical-library, calendar, timezone]
---

# Jerusalem's daylight saving starts on the wrong Friday

## Observe

`tzlib_get_ical_block('Asia/Jerusalem')` in 3.0.0 has
`RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1FR` in its `DAYLIGHT` observance.
tzdata's rule is `Fri>=23` in March: the Friday before the last Sunday, so
the 23rd to the 29th. The two differ whenever March 30 or 31 is a Friday. In
2028 the last Friday is March 31, but summer time starts on March 24.

## Why it matters

A client that reads only the event's VTIMEZONE shows an event in Israel in
that week an hour off. The alias `Asia/Tel_Aviv` gets the same block.

## Workaround

`vtimezoneComponent` in `src/caldav/ical.ts` rewrites the RRULE
to `FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29`.

## Upstream

Not reported yet.

## Drop workaround when

A release no longer writes `BYDAY=-1FR` for Jerusalem. The test
`upstream: timezones-ical-library still starts Israeli summer time on the last
Friday of March` in `src/caldav/ical.test.ts` turns red then.
