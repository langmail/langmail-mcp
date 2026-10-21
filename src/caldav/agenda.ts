// The entries list_calendar_events shows. A stored calendar object holds a
// series as one master VEVENT (DTSTART, RRULE, EXDATE) plus one override VEVENT
// per changed occurrence (RFC 5545 §3.8.4.4), and Stalwart answers a time-range
// query with every object that touches the window — so read raw, "what is on
// my calendar on Tuesday" comes back as the series' first date and overrides
// from other weeks. This module turns the stored components into what the
// question asks for: inside a window, one entry per occurrence that overlaps it,
// at its actual time; without one, every stored component once.
//
// Either way an override is completed from its master. An override only has to
// carry what changed — an attendee's reply to one occurrence is stored as an
// override with no SUMMARY of its own — and listing it bare reads as an
// untitled event at no time.
//
// Pure in/out over parsed events, like recurrence.ts.

import { type ParsedEvent, parseWallClockInZone } from '@langmail/ical'

import { seriesOccurrences } from './recurrence.ts'
import { isValidTimeZone, toWallClockIso } from './timezone.ts'

const DAY_MS = 86_400_000

// One listed event or occurrence. `event` carries this entry's own times; for
// an occurrence of a series it also carries the series' rule (`recurrence`) and
// the occurrence's original start (`recurrenceId`), which is how
// update_calendar_event and delete_calendar_event address that one occurrence.
export interface AgendaEntry {
  event: ParsedEvent
  // The occurrence's original start, in the event's own form, when it was moved
  // away from it.
  movedFrom?: string
  // Sort key: the entry's start as epoch ms.
  startMs: number
}

// The window being listed. All-day events are dates with no zone of their own,
// so they are placed on the caller's day: `allDayOffsetMs` is the UTC offset of
// the window's `start`, which is how a `2026-10-20T00:00:00+02:00` window
// covers the all-day event on 2026-10-20 and not the one on 2026-10-19.
export interface AgendaWindow {
  allDayOffsetMs: number
  end: Date
  start: Date
}

// How a VEVENT's times are written: as dates, as wall clock in a zone, as UTC
// (`…Z`), or floating (no zone at all, which we read as UTC).
type TimeForm = { kind: 'allDay' } | { kind: 'floating' } | { kind: 'utc' } | { kind: 'zoned'; timeZone: string }

const timeForm = (ev: ParsedEvent): TimeForm => {
  if (ev.allDay) {
    return { kind: 'allDay' }
  }
  if (ev.startTzid && isValidTimeZone(ev.startTzid)) {
    return { kind: 'zoned', timeZone: ev.startTzid }
  }
  return ev.start.endsWith('Z') ? { kind: 'utc' } : { kind: 'floating' }
}

// An instant written back in the event's own form, as `ParsedEvent.start` holds
// it. All-day values are UTC midnights (see dateOnlyToInstant).
const display = (at: Date, form: TimeForm): string => {
  switch (form.kind) {
    case 'allDay':
      return at.toISOString().slice(0, 10)
    case 'zoned':
      return toWallClockIso(at, form.timeZone)
    case 'floating':
      return at.toISOString().slice(0, 19)
    default:
      return `${at.toISOString().slice(0, 19)}Z`
  }
}

const FLOATING_DATE_TIME_RE = /T\d{2}:\d{2}:\d{2}$/u

// The instant a stored value names, or NaN when it has none (an empty DTEND).
// Inverse of display.
const instantOf = (value: string, form: TimeForm): number => {
  if (value === '') {
    return Number.NaN
  }
  if (!FLOATING_DATE_TIME_RE.test(value)) {
    return Date.parse(value)
  }
  return form.kind === 'zoned' ? parseWallClockInZone(value, form.timeZone).getTime() : Date.parse(`${value}Z`)
}

// A stored EXDATE value as an instant. The parser already resolved TZID values
// to UTC; DATE values read as UTC midnights, and a floating value as UTC.
const excludedMs = (value: string): number =>
  FLOATING_DATE_TIME_RE.test(value) ? Date.parse(`${value}Z`) : Date.parse(value)

// An event's length, for occurrences generated from it. No DTEND means a
// zero-length timed event or a one-day all-day one (RFC 5545 §3.6.1).
const durationMs = (ev: ParsedEvent, form: TimeForm): number => {
  const length = instantOf(ev.end, form) - instantOf(ev.start, form)
  if (!Number.isNaN(length)) {
    return length
  }
  return form.kind === 'allDay' ? DAY_MS : 0
}

// An override with the master's values filled in where it carries none. An
// override's attendee list is its own per-occurrence state (each reply to this
// day), so it is only borrowed when the override has no attendees at all.
const completeOverride = (override: ParsedEvent, master: ParsedEvent | undefined): ParsedEvent => {
  if (!master) {
    return override
  }
  // The master's times and their form never carry over to an override that has
  // its own DTSTART, nor do the series' exclusions to a single occurrence.
  const { allDay, end: _end, excludedDates: _excluded, start: _start, startTzid, ...series } = master
  const merged: ParsedEvent = {
    ...series,
    ...override,
    attendees: override.attendees.length > 0 ? override.attendees : master.attendees,
    title: override.title || master.title,
  }
  if (override.start !== '' || override.recurrenceId === undefined) {
    return merged
  }
  // No DTSTART of its own: the occurrence sits at its original start, with the
  // series' length.
  const form = timeForm(master)
  const start = new Date(override.recurrenceId)
  const end = new Date(start.getTime() + durationMs(master, form))
  return {
    ...merged,
    ...(allDay ? { allDay } : {}),
    ...(startTzid ? { startTzid } : {}),
    end: master.end === '' ? '' : display(end, form),
    start: display(start, form),
  }
}

const overrideEntry = (override: ParsedEvent, master: ParsedEvent | undefined): AgendaEntry => {
  const event = completeOverride(override, master)
  const form = timeForm(event)
  const startMs = instantOf(event.start, form)
  const originalMs = event.recurrenceId ? Date.parse(event.recurrenceId) : startMs
  const entry: AgendaEntry = { event, startMs }
  if (!Number.isNaN(startMs) && originalMs !== startMs) {
    entry.movedFrom = display(new Date(originalMs), master ? timeForm(master) : form)
  }
  return entry
}

const plainEntry = (event: ParsedEvent): AgendaEntry => ({
  event,
  startMs: instantOf(event.start, timeForm(event)),
})

// Groups a calendar object's VEVENTs by UID into series: the master (absent when
// only some occurrences were shared with this calendar) and its overrides.
interface Series {
  master?: ParsedEvent
  overrides: ParsedEvent[]
}

const groupSeries = (events: ParsedEvent[]): Series[] => {
  const byUid = new Map<string, Series>()
  for (const ev of events) {
    const series = byUid.get(ev.uid) ?? { overrides: [] }
    if (ev.recurrenceId === undefined) {
      series.master = ev
    } else {
      series.overrides.push(ev)
    }
    byUid.set(ev.uid, series)
  }
  return [...byUid.values()]
}

// Every stored component once: masters and one-off events as they are,
// overrides completed from their master. The listing without a window.
export const storedEntries = (events: ParsedEvent[]): AgendaEntry[] =>
  groupSeries(events).flatMap(({ master, overrides }) => [
    ...(master ? [plainEntry(master)] : []),
    ...overrides.map((o) => overrideEntry(o, master)),
  ])

// [start, end) overlaps the window. A zero-length event counts when it starts
// inside it. All-day entries are compared on the caller's day (AgendaWindow).
const overlaps = (entry: AgendaEntry, window: AgendaWindow): boolean => {
  if (Number.isNaN(entry.startMs)) {
    return true
  }
  const form = timeForm(entry.event)
  const shift = form.kind === 'allDay' ? window.allDayOffsetMs : 0
  const from = window.start.getTime() + shift
  const to = window.end.getTime() + shift
  const endMs = instantOf(entry.event.end, form)
  const end = Number.isNaN(endMs) ? entry.startMs + durationMs(entry.event, form) : endMs
  return entry.startMs < to && (end > from || (end === entry.startMs && entry.startMs >= from))
}

// The occurrences of a master's rule that start in the expanded range, minus
// excluded dates and the ones an override replaces. Generated a duration early
// (an occurrence that started before the window may still run into it) and
// with a day's slack each way for all-day dates; `overlaps` makes the call.
const generatedEntries = (master: ParsedEvent, rule: string, overridden: Set<number>, window: AgendaWindow) => {
  const form = timeForm(master)
  const length = durationMs(master, form)
  const from = new Date(window.start.getTime() - length - DAY_MS)
  const to = new Date(window.end.getTime() + DAY_MS)
  const excluded = new Set((master.excludedDates ?? []).map(excludedMs))
  const masterStart = form.kind === 'floating' ? `${master.start}Z` : master.start
  const timeZone = form.kind === 'zoned' ? form.timeZone : undefined
  return seriesOccurrences(masterStart, rule, from, to, timeZone)
    .filter((at) => !(excluded.has(at.getTime()) || overridden.has(at.getTime())))
    .map((at): AgendaEntry => {
      const { excludedDates: _excluded, ...series } = master
      return {
        event: {
          ...series,
          end: master.end === '' ? '' : display(new Date(at.getTime() + length), form),
          recurrenceId: at.toISOString(),
          start: display(at, form),
        },
        startMs: at.getTime(),
      }
    })
}

const seriesInWindow = ({ master, overrides }: Series, window: AgendaWindow): AgendaEntry[] => {
  const replaced = overrides.map((o) => overrideEntry(o, master))
  const rule = master?.recurrence
  if (!(master && rule)) {
    return [...(master ? [plainEntry(master)] : []), ...replaced]
  }
  const overridden = new Set(overrides.map((o) => Date.parse(o.recurrenceId ?? '')))
  let generated: AgendaEntry[]
  try {
    generated = generatedEntries(master, rule, overridden, window)
  } catch {
    // A rule rrule can't read: list the series as stored rather than drop it.
    generated = [plainEntry(master)]
  }
  return [...generated, ...replaced]
}

// The entries that overlap the window: one per occurrence for a series, each at
// its actual time; one-off events as they are.
export const windowEntries = (events: ParsedEvent[], window: AgendaWindow): AgendaEntry[] =>
  groupSeries(events)
    .flatMap((series) => seriesInWindow(series, window))
    .filter((entry) => overlaps(entry, window))
