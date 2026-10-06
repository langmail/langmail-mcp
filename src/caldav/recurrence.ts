// Recurrence (RRULE) input for the calendar event tools. The agent can
// express a repeating series two ways: a raw iCalendar RRULE string (most
// flexible — Claude knows RFC 5545 well) or a small structured object
// (friendlier to fill in field-by-field). Both normalize to a single RRULE
// string that ical-generator serializes onto the VEVENT (see ical.ts).

import { TZDate } from '@date-fns/tz'
import { rrulestr } from 'rrule'
import { z } from 'zod'

import { parseWallClockInZone } from '@langmail/ical'

import { dateOnlyToInstant, isDateOnly, isValidTimeZone, toWallClockIso } from './timezone.ts'

// RFC 5545 FREQ values we expose. Lowercase in the structured form for the
// model's convenience; uppercased when emitted into the RRULE.
const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const

// RFC 5545 BYDAY weekday codes.
const RECURRENCE_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

// A raw RRULE, e.g. `FREQ=WEEKLY;BYDAY=TH`. We accept (and strip) a leading
// `RRULE:` so a model that includes the property name still works, and we
// require a `FREQ=` so obvious garbage is rejected before it reaches CalDAV.
// The value must be a single line: `event.repeating(string)` splices a
// multi-line value in verbatim, so a CRLF would inject extra VEVENT content
// lines (a second SUMMARY, an ATTENDEE, …). Forbid line breaks to close that.
const rawRruleSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(
    /^(?:RRULE:)?FREQ=[^\r\n]*$/iu,
    'recurrence must be a single-line iCalendar RRULE starting with FREQ=, e.g. "FREQ=WEEKLY;BYDAY=TH"'
  )

// Structured recurrence — a friendlier shape than a raw RRULE.
const structuredRecurrenceSchema = z
  .object({
    byDay: z.array(z.enum(RECURRENCE_WEEKDAYS)).min(1).max(7).optional().describe('Weekdays (RFC 5545 codes MO–SU).'),
    count: z.number().int().min(1).max(1000).optional().describe('Total occurrences; not with `until`.'),
    frequency: z.enum(RECURRENCE_FREQUENCIES).describe('How often it repeats.'),
    interval: z.number().int().min(1).max(1000).optional().describe('Every N periods; defaults to 1.'),
    until: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .optional()
      .describe('Last day (YYYY-MM-DD) or instant of the series; not with `count`.'),
  })
  .refine((r) => !(r.until !== undefined && r.count !== undefined), {
    message: 'Provide at most one of `until` or `count`, not both.',
  })

// Either form. Listed raw-string-first so a plain RRULE doesn't get coerced
// toward the object branch.
export const recurrenceSchema = z.union([rawRruleSchema, structuredRecurrenceSchema])

export type Recurrence = z.infer<typeof recurrenceSchema>

// Human-facing description of the recurrence *shape*, attached to the
// `recurrence` field on both calendar event tools (each prefixes its own
// per-tool sentence). Kept here so create/update stay in sync — and kept short,
// because this string is part of what tool search ranks on.
export const recurrenceDescription =
  'Either a raw RFC 5545 RRULE ("FREQ=WEEKLY;BYDAY=TH", "FREQ=DAILY;COUNT=10") or ' +
  '{frequency, interval?, byDay?, until?|count?}. Use at most one of until/count; ' +
  'The object’s `until` is ISO (2026-12-31 or 2026-12-31T00:00:00Z); a raw UNTIL is compact ' +
  '(20261231 or 20261231T000000Z). Either is converted to match the event (a date on an all-day series). ' +
  'A raw rule is only lightly validated, so a malformed one fails later at the server.'

// ISO `2026-12-31T00:00:00.000Z` → iCalendar `20261231T000000Z`: drop the
// date/time separators, then the milliseconds.
const ISO_SEPARATORS_RE = /[-:]/gu
const ISO_MILLIS_RE = /\.\d{3}Z$/u
const EVENT_TIME_ZONE_SUFFIX_RE = / ([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/u

// A leading `RRULE:` property name on a raw rule, which ical-generator re-adds.
const RRULE_PREFIX_RE = /^RRULE:/iu

// RFC 5545 wants a UTC date-time (`YYYYMMDDTHHMMSSZ`) for non-floating values —
// an RRULE UNTIL, an EXDATE. Our events are UTC, so normalize the ISO instant.
export const toIcalUtc = (iso: string): string =>
  new Date(iso).toISOString().replace(ISO_SEPARATORS_RE, '').replace(ISO_MILLIS_RE, 'Z')

const toIcalFloating = (iso: string): string =>
  iso.replace(EVENT_TIME_ZONE_SUFFIX_RE, '').replace(ISO_SEPARATORS_RE, '')

// Normalizes either input form to a raw RRULE string *without* the `RRULE:`
// prefix — ical-generator re-adds it on serialization.
export const toRRule = (recurrence: Recurrence): string => {
  if (typeof recurrence === 'string') {
    return recurrence.trim().replace(RRULE_PREFIX_RE, '')
  }

  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`]
  if (recurrence.interval !== undefined) {
    parts.push(`INTERVAL=${recurrence.interval}`)
  }
  if (recurrence.byDay) {
    parts.push(`BYDAY=${recurrence.byDay.join(',')}`)
  }
  if (recurrence.count !== undefined) {
    parts.push(`COUNT=${recurrence.count}`)
  }
  if (recurrence.until !== undefined) {
    // A date stays a date here; alignUntil re-types it to match the event.
    parts.push(
      `UNTIL=${DATE_ONLY_ISO_RE.test(recurrence.until) ? recurrence.until.replaceAll('-', '') : toIcalUtc(recurrence.until)}`
    )
  }
  return parts.join(';')
}

const DATE_ONLY_ISO_RE = /^\d{4}-\d{2}-\d{2}$/u
const UNTIL_RE = /(^|;)UNTIL=([^;]*)/iu
const ICAL_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/u
const ICAL_UTC_DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/iu
const ICAL_FLOATING_DATE_TIME_RE = /^(\d{8})T\d{6}$/u

// The UNTIL value re-typed for the event it bounds, or undefined to keep it.
const alignedUntil = (value: string, allDay: boolean, timeZone: string): string | undefined => {
  const date = ICAL_DATE_RE.exec(value)
  const utc = ICAL_UTC_DATE_TIME_RE.exec(value)
  if (allDay) {
    if (utc) {
      const [, y, mo, d, h, mi, s] = utc
      const instant = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
      return toWallClockIso(instant, timeZone).slice(0, 10).replaceAll('-', '')
    }
    return ICAL_FLOATING_DATE_TIME_RE.exec(value)?.[1]
  }
  if (date) {
    // "Until Dec 31" on a timed series includes that whole day.
    const [, y, mo, d] = date
    return toIcalUtc(parseWallClockInZone(`${y}-${mo}-${d}T23:59:59`, timeZone).toISOString())
  }
  return
}

// RFC 5545 §3.3.10: UNTIL must have the same value type as DTSTART — a DATE on
// an all-day series, a UTC DATE-TIME on a timed (zoned or UTC) one. Rules
// arrive in either form (a structured date, a raw rule, a rule preserved from
// storage across a timed↔all-day switch), so every rule is aligned right
// before it is written. A date-time becomes its calendar date in `timeZone`; a
// date on a timed series becomes the end of that day in `timeZone`.
export const alignUntil = (rrule: string, allDay: boolean, timeZone: string): string => {
  const match = UNTIL_RE.exec(rrule)
  const aligned = match?.[2] ? alignedUntil(match[2].trim(), allDay, timeZone) : undefined
  return aligned === undefined ? rrule : rrule.replace(UNTIL_RE, `$1UNTIL=${aligned}`)
}

// BYDAY on a raw rule, and the parts of a rule that make a naive weekday check
// unsafe: with BYSETPOS or BYMONTHDAY the listed weekdays are a filter within a
// larger pattern rather than the days the series lands on.
const BYDAY_RE = /(?:^|;)BYDAY=([^;]+)/iu
const COMPLEX_RULE_RE = /(?:^|;)(?:BYSETPOS|BYMONTHDAY|BYYEARDAY|BYWEEKNO)=/iu
// Strips an RFC 5545 ordinal prefix (`2TU`, `-1FR`) down to the weekday code.
const BYDAY_ORDINAL_RE = /^[+-]?\d*/u
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

// True when moving a series to `start` would contradict the repeat rule it is
// keeping — e.g. `FREQ=WEEKLY;BYDAY=TU` with a Friday start, which RFC 5545
// reads as "that Friday, plus every Tuesday" rather than "every Friday". The
// caller has to re-rule the series explicitly instead. Only the unambiguous
// weekday case is judged; rules whose BYDAY is a filter within a larger pattern
// are left alone rather than risk refusing a legitimate edit.
export const startContradictsRule = (rrule: string, start: Date, timeZone: string): boolean => {
  if (COMPLEX_RULE_RE.test(rrule)) {
    return false
  }
  const byDay = BYDAY_RE.exec(rrule)?.[1]
  if (!byDay) {
    return false
  }
  const days = byDay.split(',').map((d) => d.trim().replace(BYDAY_ORDINAL_RE, '').toUpperCase())
  const weekday = WEEKDAY_CODES[TZDate.tz(timeZone, start).getDay()]
  return weekday !== undefined && days.length > 0 && !days.includes(weekday)
}

// A zoned series is expanded on its floating wall clock (see isSeriesOccurrence),
// but RFC 5545 §3.3.10 writes its UNTIL in UTC. Re-express that UNTIL as wall
// clock in the same zone, or `rrule` compares it against wall clock read as UTC
// and, east of UTC, drops the last occurrence.
const floatUntil = (rrule: string, timeZone: string): string => {
  const match = UNTIL_RE.exec(rrule)
  const utc = ICAL_UTC_DATE_TIME_RE.exec(match?.[2]?.trim() ?? '')
  if (!utc) {
    return rrule
  }
  const [, y, mo, d, h, mi, s] = utc
  const wallClock = toWallClockIso(new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`), timeZone)
  return rrule.replace(UNTIL_RE, `$1UNTIL=${toIcalFloating(wallClock)}`)
}

// The zone a series' RRULE expands in, for isSeriesOccurrence: the master's
// DTSTART TZID on a timed series, none on an all-day one (a TZID some producers
// write beside a DATE has no wall clock to govern). A TZID that isn't an IANA
// zone (a Windows ID defined only by the object's VTIMEZONE) can't be expanded
// at all, so it is refused by name rather than surfacing as an opaque rule error
// — and never matched as if its wall clock were UTC.
export const seriesTimeZone = (master: {
  allDay?: true
  startTzid?: string
}): { error: string; ok: false } | { ok: true; value: string | undefined } => {
  const zone = master.allDay ? undefined : master.startTzid
  if (zone && !isValidTimeZone(zone)) {
    return {
      error: `This series' time zone (${zone}) is not a recognized IANA zone, so recurrenceId cannot be matched to an occurrence.`,
      ok: false,
    }
  }
  return { ok: true, value: zone }
}

// True when `recurrenceId` (an ISO 8601 instant) is the original start of an
// occurrence the series generates — i.e. expanding `rrule` from `masterStart`
// lands exactly on it. update_calendar_event uses this to reject an occurrence
// override that would otherwise dangle off the series: RFC 5545 §3.8.4.4
// requires a RECURRENCE-ID to name a real instance of the master's RRULE.
//
// Membership is tested with a single-instant `between(t, t, inclusive)` rather
// than expanding the whole (possibly unbounded) series. Our events are UTC, so
// both bounds are normalized to a UTC DTSTART before handing off to `rrule`.
export const isSeriesOccurrence = (
  masterStart: string,
  rrule: string,
  recurrenceId: string,
  timeZone?: string
): boolean => {
  const start = timeZone ? toIcalFloating(masterStart) : toIcalUtc(masterStart)
  const rule = rrulestr(`DTSTART:${start}\nRRULE:${timeZone ? floatUntil(rrule, timeZone) : rrule}`)
  const at = timeZone ? new Date(`${toWallClockIso(new Date(recurrenceId), timeZone)}Z`) : new Date(recurrenceId)
  return rule.between(at, at, true).length > 0
}

// The occurrence a caller's `recurrenceId` names, as an ISO instant, for the
// series `master` heads. An all-day series' occurrences start at a date, so it
// takes the date (`2026-06-23`), resolved to its UTC midnight — the instant the
// parser and the splice give a DATE RECURRENCE-ID or EXDATE. A timed series
// takes the occurrence's original start date-time. The wrong kind is refused
// in both directions rather than coerced: a date-time's calendar day depends
// on its offset, so truncating one could name the neighbouring occurrence.
export const resolveRecurrenceId = (
  recurrenceId: string,
  master: { allDay?: true; recurrence?: string } | undefined
): { error: string; ok: false } | { ok: true; value: string } => {
  const dateOnly = isDateOnly(recurrenceId)
  if (master?.allDay) {
    return dateOnly
      ? { ok: true, value: dateOnlyToInstant(recurrenceId).toISOString() }
      : {
          // Name the UTC day of the instant and say so: whether that or the
          // leading digits is the day the caller meant depends on how they
          // computed the value, so the hint must not pass a guess off as fact.
          error:
            'This series is all-day; pass recurrenceId as the occurrence’s date (YYYY-MM-DD). The instant you ' +
            `passed falls on ${new Date(recurrenceId).toISOString().slice(0, 10)} in UTC.`,
          ok: false,
        }
  }
  if (dateOnly && master?.recurrence !== undefined) {
    return {
      error: `This series is not all-day; pass recurrenceId as the occurrence’s original start date-time (e.g. ${recurrenceId}T10:00:00Z).`,
      ok: false,
    }
  }
  return { ok: true, value: recurrenceId }
}
