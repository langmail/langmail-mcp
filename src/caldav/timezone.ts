import { TZDate } from '@date-fns/tz'
import { z } from 'zod'

// The wall-clock parser lives in src/ical, where the VEVENT parser
// consumes it — this module keeps the zod input schemas that validate tool
// arguments, which are the tools' concern, not the parser's.
import { DATE_TIME_RE, ianaTimeZone, parseWallClockInZone } from '../ical/index.ts'

const OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/iu

export const UTC_TIME_ZONE = 'UTC'

export const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone === UTC_TIME_ZONE) {
    return true
  }
  if (Intl.supportedValuesOf('timeZone').includes(timeZone)) {
    return true
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return true
  } catch {
    return false
  }
}

export const timeZoneSchema = z.string().refine(isValidTimeZone, {
  message: 'timeZone must be a valid IANA timezone, e.g. Europe/Berlin',
})

// DATE_TIME_RE narrows z.iso.datetime to what parseWallClockInZone reads: zod
// alone also takes minute precision (`10:00`) and any number of fractional
// digits, which would pass validation and then throw in resolveEventTimes.
const dateTimeWithOptionalOffsetSchema = z.iso.datetime({ offset: true, local: true }).regex(DATE_TIME_RE)

// An event's start or end: a date-time for a timed event, or a bare date
// (`2026-10-03`) for an all-day one. The value type *is* the all-day signal,
// exactly as in RFC 5545 (`DTSTART;VALUE=DATE`) — see resolveEventTimes.
// The union's own message is what a caller sees: zod's default for a failed
// union is a bare "Invalid input", which does not say what to send instead.
export const eventTimeSchema = z.union([z.iso.date(), dateTimeWithOptionalOffsetSchema], {
  error:
    'Expected a date (2026-10-03) for an all-day event, or a date-time with seconds (2026-10-03T10:00:00, ' +
    'optionally with up to three fractional digits and Z or an offset like +02:00).',
})

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u

// True for a bare ISO date (`2026-10-03`) — an all-day value.
export const isDateOnly = (value: string | undefined): value is string =>
  value !== undefined && DATE_ONLY_RE.test(value)

// All-day dates travel through the date-time pipeline as UTC midnights: day
// arithmetic on them is exact (no DST), and buildInvite formats them back in
// UTC, recovering the very same calendar date.
export const dateOnlyToInstant = (date: string): Date => new Date(`${date}T00:00:00Z`)

export const instantToDateOnly = (instant: Date): string => instant.toISOString().slice(0, 10)

const DAY_MS = 86_400_000

// The resolved times of an event: instants for a timed event, UTC midnights
// (see dateOnlyToInstant) for an all-day one.
export interface EventTimes {
  allDay: boolean
  end: Date
  start: Date
}

export type EventTimesResolution = { error: string; ok: false } | { ok: true; value: EventTimes }

// Resolves a caller's start/end pair. Both must be dates (all-day) or both
// date-times (timed); an all-day `end` is exclusive (RFC 5545 §3.6.1), so a
// one-day event on Oct 3 ends on Oct 4 — the likeliest slip, `end == start`,
// is refused with the value to use instead.
export const resolveEventTimes = (
  start: string,
  end: string,
  timeZone: string,
  explicitTimeZone: boolean
): EventTimesResolution => {
  const allDay = isDateOnly(start)
  if (allDay !== isDateOnly(end)) {
    return {
      error:
        'Pass `start` and `end` both as dates (YYYY-MM-DD) for an all-day event, or both as date-times for a timed one.',
      ok: false,
    }
  }
  if (allDay) {
    const startAt = dateOnlyToInstant(start)
    const endAt = dateOnlyToInstant(end)
    if (endAt <= startAt) {
      return { error: allDayEndError(start), ok: false }
    }
    return { ok: true, value: { allDay, end: endAt, start: startAt } }
  }
  const startAt = resolveInputDateTime(start, timeZone, explicitTimeZone)
  const endAt = resolveInputDateTime(end, timeZone, explicitTimeZone)
  if (endAt <= startAt) {
    return { error: 'Event end must be after its start.', ok: false }
  }
  return { ok: true, value: { allDay, end: endAt, start: startAt } }
}

// The refusal for an all-day end on or before its start, naming the value a
// single-day event needs.
export const allDayEndError = (start: string): string =>
  `An all-day event's \`end\` is exclusive — the day after its last day. For a single day on ${start}, ` +
  `pass end ${instantToDateOnly(new Date(dateOnlyToInstant(start).getTime() + DAY_MS))}.`

const hasExplicitOffset = (value: string): boolean => OFFSET_RE.test(value)

// A Windows zone name, as a stored TZID may carry one, reads as its IANA zone
// here and in toWallClockIso, like parseWallClockInZone.
export const toZonedDate = (instant: Date, timeZone: string): Date =>
  timeZone === UTC_TIME_ZONE ? instant : TZDate.tz(ianaTimeZone(timeZone), instant)

// An instant re-expressed as a naive wall-clock ISO string in `timeZone` (no
// offset suffix) — the inverse of parseWallClockInZone. Used wherever a stored
// instant has to re-enter the wall-clock pipeline, e.g. an occurrence's original
// start standing in for an omitted `start` on an update.
export const toWallClockIso = (instant: Date, timeZone: string): string => {
  const zoned = TZDate.tz(ianaTimeZone(timeZone), instant)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${zoned.getFullYear()}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}` +
    `T${pad(zoned.getHours())}:${pad(zoned.getMinutes())}:${pad(zoned.getSeconds())}`
  )
}

export const resolveInputDateTime = (value: string, timeZone: string, explicitTimeZone: boolean): Date => {
  if (explicitTimeZone || !hasExplicitOffset(value)) {
    return parseWallClockInZone(value, timeZone)
  }
  return new Date(value)
}
