---
type: upstream
title: Morocco's zones are written as UTC+0 all year
description: The library's VTIMEZONE for Africa/Casablanca and Africa/El_Aaiun is a fixed +0000, but Morocco has been on +01 outside Ramadan since 2018; other clients would show such events an hour off most of the year, so we rewrite the offset to +0100.
status: open
observed: 3.0.0
owner: dominik
tags: [timezones-ical-library, calendar, timezone]
---

# Morocco is written as UTC+0

## Observe

`tzlib_get_ical_block('Africa/Casablanca')` (and `Africa/El_Aaiun`) in 3.0.0
returns one `STANDARD` observance with `TZOFFSETFROM:+0000`,
`TZOFFSETTO:+0000`, `TZNAME:+00`. tzdata has Morocco on +01 since October
2018, dropping back to +00 only for about a month around Ramadan. The library
appears to take the Ramadan offset as the zone's standard time, since tzdata
models +01 as daylight saving with a negative save around Ramadan.

## Why it matters

A client that reads only the event's VTIMEZONE shows an event in Morocco an
hour off for about eleven months a year.

## Workaround

`vtimezoneComponent` in `src/caldav/ical.ts` rewrites the block's
offsets to `+0100`. That is still an hour off during Ramadan, a lunar date no
yearly RRULE can state; the offset test in `ical.test.ts` skips both zones
for that reason.

## Upstream

Not reported yet.

## Drop workaround when

A release writes `TZOFFSETTO:+0100` for `Africa/Casablanca` outside Ramadan.
The test `upstream: timezones-ical-library still writes Morocco as UTC+0` in
`src/caldav/ical.test.ts` turns red then.
