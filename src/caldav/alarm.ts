// Reminders (VALARM) as the calendar tools speak about them: a number of
// minutes before the start. Writing goes through buildInvite (InviteAlarm);
// this module renders them for tool output.

import { icalDateToIso, type ParsedAlarm } from '@langmail/ical'

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 1440
const MINUTES_PER_WEEK = 10_080

// The upper bound on `reminderMinutesBefore`: four weeks.
export const MAX_REMINDER_MINUTES = 4 * MINUTES_PER_WEEK

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

// 30 → "30 minutes", 60 → "1 hour", 1440 → "1 day"; the largest whole unit.
export const formatMinutes = (minutes: number): string => {
  if (minutes > 0 && minutes % MINUTES_PER_WEEK === 0) {
    return plural(minutes / MINUTES_PER_WEEK, 'week')
  }
  if (minutes > 0 && minutes % MINUTES_PER_DAY === 0) {
    return plural(minutes / MINUTES_PER_DAY, 'day')
  }
  if (minutes > 0 && minutes % MINUTES_PER_HOUR === 0) {
    return plural(minutes / MINUTES_PER_HOUR, 'hour')
  }
  return plural(minutes, 'minute')
}

// A relative TRIGGER (RFC 5545 §3.3.6 duration, e.g. `-PT30M`, `-P1D`,
// `-P1W`, `PT0S`), as a signed number of minutes; undefined when it is not a
// duration.
const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/iu
const durationMinutes = (value: string): number | undefined => {
  const m = DURATION_RE.exec(value)
  if (!m) {
    return
  }
  const [, sign, w = '0', d = '0', h = '0', mi = '0', s = '0'] = m
  const minutes =
    Number(w) * MINUTES_PER_WEEK +
    Number(d) * MINUTES_PER_DAY +
    Number(h) * MINUTES_PER_HOUR +
    Number(mi) +
    Math.round(Number(s) / 60)
  return sign === '-' ? -minutes : minutes
}

const RELATED_END_RE = /(?:^|;)RELATED=END(?:;|$)/iu

const pad2 = (n: number): string => String(n).padStart(2, '0')

// A reminder `minutes` before an all-day event's 00:00 start, as the clock
// time it actually fires: "09:00 the day before", "00:00 on the day",
// "18:00 2 days before". "1 day before start" would hide that it is midnight.
const allDayFiring = (minutes: number): string => {
  const daysBack = Math.ceil(minutes / MINUTES_PER_DAY)
  const clock = daysBack * MINUTES_PER_DAY - minutes
  const time = `${pad2(Math.floor(clock / MINUTES_PER_HOUR))}:${pad2(clock % MINUTES_PER_HOUR)}`
  if (daysBack === 0) {
    return `${time} on the day`
  }
  return `${time} ${daysBack === 1 ? 'the day' : `${daysBack} days`} before`
}

// One stored alarm in words: "30 minutes before start", "at start",
// "1 hour after end", "at 2026-10-02T09:00:00Z" (absolute trigger). On an
// all-day event a reminder before the start is shown as the clock time it
// fires ("09:00 the day before").
export const describeAlarm = (alarm: ParsedAlarm, allDay = false): string => {
  const trigger = alarm.trigger ?? ''
  const minutes = durationMinutes(trigger)
  if (minutes === undefined) {
    return trigger ? `at ${icalDateToIso(trigger)}` : 'unknown trigger'
  }
  const anchor = RELATED_END_RE.test(alarm.triggerParams ?? '') ? 'end' : 'start'
  if (allDay && anchor === 'start' && minutes <= 0) {
    return allDayFiring(-minutes)
  }
  if (minutes === 0) {
    return `at ${anchor}`
  }
  return `${formatMinutes(Math.abs(minutes))} ${minutes < 0 ? 'before' : 'after'} ${anchor}`
}
