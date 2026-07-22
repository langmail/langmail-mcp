// Recurrence (RRULE) input for the calendar event tools. The agent can
// express a repeating series two ways: a raw iCalendar RRULE string (most
// flexible — Claude knows RFC 5545 well) or a small structured object
// (friendlier to fill in field-by-field). Both normalize to a single RRULE
// string that ical-generator serializes onto the VEVENT (see ical.ts).

import { TZDate } from '@date-fns/tz'
import { rrulestr } from 'rrule'
import { z } from 'zod'

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
    byDay: z
      .array(z.enum(RECURRENCE_WEEKDAYS))
      .min(1)
      .max(7)
      .optional()
      .describe('Weekdays the event falls on (RFC 5545 codes): MO, TU, WE, TH, FR, SA, SU.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Total number of occurrences. Mutually exclusive with `until`.'),
    frequency: z.enum(RECURRENCE_FREQUENCIES).describe('How often the event repeats.'),
    interval: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Repeat every N periods (e.g. 2 with weekly = fortnightly). Defaults to 1.'),
    until: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('ISO 8601 instant after which the series stops. Mutually exclusive with `count`.'),
  })
  .refine((r) => !(r.until !== undefined && r.count !== undefined), {
    message: 'Provide at most one of `until` or `count`, not both.',
  })

// Either form. Listed raw-string-first so a plain RRULE doesn't get coerced
// toward the object branch.
export const recurrenceSchema = z.union([rawRruleSchema, structuredRecurrenceSchema])

export type Recurrence = z.infer<typeof recurrenceSchema>

// Human-facing description attached to the optional `recurrence` field on both
// calendar event tools. Kept here so create/update stay in sync.
export const recurrenceDescription =
  'Optional recurrence rule that turns this into a repeating series; omit for a ' +
  'single one-off event. Either a raw iCalendar RRULE string ' +
  '(e.g. "FREQ=WEEKLY;BYDAY=TH" for every Thursday, "FREQ=DAILY;COUNT=10" for ten ' +
  'days) or a structured object {frequency, interval?, byDay?, until?|count?}. ' +
  'start/end describe the first occurrence. Use at most one of until/count; ' +
  'in a raw RRULE express UNTIL as a UTC date-time (e.g. UNTIL=20261231T000000Z). ' +
  'A raw RRULE is only lightly validated, so it must be valid RFC 5545 ' +
  '(e.g. BYDAY codes MO–SU) — malformed rules surface as CalDAV server errors.'

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

const instantToFloatingIsoInZone = (iso: string, timeZone: string): string => {
  const date = TZDate.tz(timeZone, new Date(iso))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

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
    parts.push(`UNTIL=${toIcalUtc(recurrence.until)}`)
  }
  return parts.join(';')
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
  const rule = rrulestr(`DTSTART:${start}\nRRULE:${rrule}`)
  const at = timeZone ? new Date(`${instantToFloatingIsoInZone(recurrenceId, timeZone)}Z`) : new Date(recurrenceId)
  return rule.between(at, at, true).length > 0
}
