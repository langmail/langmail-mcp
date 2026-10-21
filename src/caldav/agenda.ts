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

// How many occurrences one series may generate for a window. Bounds the work a
// `FREQ=MINUTELY` series over a long window costs; the tool shows fewer still.
const MAX_GENERATED = 1000

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
  // A series whose repeat rule could not be expanded, listed as stored so it
  // isn't silently missing from the window.
  unexpanded?: true
}

// The window being listed, `end` exclusive. All-day events are dates with no
// zone of their own, so they are placed on the caller's days: each bound keeps
// the UTC offset it was written with, which is how a `2026-10-20T00:00:00+02:00`
// window covers the all-day event on 2026-10-20 and not the one on 2026-10-19 —
// and a week that runs across a DST change still ends at the caller's midnight.
export interface AgendaWindow {
  end: Date
  endOffsetMs: number
  start: Date
  startOffsetMs: number
}

// The UTC offset written on an ISO 8601 date-time (`Z`, `+02:00`), in ms.
const OFFSET_RE = /([+-])(\d{2}):(\d{2})$/u
const offsetMs = (iso: string): number => {
  const match = OFFSET_RE.exec(iso)
  if (!match) {
    return 0
  }
  const [, sign, hours, minutes] = match
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000
}

// The window between two ISO 8601 date-times with offsets.
export const agendaWindow = (start: string, end: string): AgendaWindow => ({
  end: new Date(end),
  endOffsetMs: offsetMs(end),
  start: new Date(start),
  startOffsetMs: offsetMs(start),
})

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
    // In the occurrence's own form, so the zone `when:` names reads right for it too.
    entry.movedFrom = display(new Date(originalMs), form)
  }
  return entry
}

const plainEntry = (event: ParsedEvent): AgendaEntry => ({
  event,
  startMs: instantOf(event.start, timeForm(event)),
})

// Groups a calendar object's VEVENTs by UID into series: the master (absent when
// only some occurrences were shared with this calendar), its overrides, and any
// further component without a RECURRENCE-ID the parser could read — an override
// whose RECURRENCE-ID names a non-IANA zone (Outlook's `W. Europe Standard
// Time`). Those are listed as they are rather than taking the master's place.
interface Series {
  master?: ParsedEvent
  others: ParsedEvent[]
  overrides: ParsedEvent[]
}

const addComponent = (series: Series, ev: ParsedEvent): void => {
  if (ev.recurrenceId !== undefined) {
    series.overrides.push(ev)
  } else if (!series.master) {
    series.master = ev
  } else if (ev.recurrence && !series.master.recurrence) {
    series.others.push(series.master)
    series.master = ev
  } else {
    series.others.push(ev)
  }
}

const groupSeries = (events: ParsedEvent[]): Series[] => {
  const byUid = new Map<string, Series>()
  for (const ev of events) {
    const series = byUid.get(ev.uid) ?? { others: [], overrides: [] }
    addComponent(series, ev)
    byUid.set(ev.uid, series)
  }
  return [...byUid.values()]
}

// Every stored component once: masters and one-off events as they are,
// overrides completed from their master. The listing without a window.
export const storedEntries = (events: ParsedEvent[]): AgendaEntry[] =>
  groupSeries(events).flatMap(({ master, others, overrides }) => [
    ...(master ? [plainEntry(master)] : []),
    ...others.map(plainEntry),
    ...overrides.map((o) => overrideEntry(o, master)),
  ])

// [start, end) overlaps the window. A zero-length event counts when it starts
// inside it. All-day entries are compared on the caller's day (AgendaWindow).
const overlaps = (entry: AgendaEntry, window: AgendaWindow): boolean => {
  if (entry.unexpanded || Number.isNaN(entry.startMs)) {
    return true
  }
  const form = timeForm(entry.event)
  const allDay = form.kind === 'allDay'
  const from = window.start.getTime() + (allDay ? window.startOffsetMs : 0)
  const to = window.end.getTime() + (allDay ? window.endOffsetMs : 0)
  const endMs = instantOf(entry.event.end, form)
  const end = Number.isNaN(endMs) ? entry.startMs + durationMs(entry.event, form) : endMs
  return entry.startMs < to && (end > from || (end === entry.startMs && entry.startMs >= from))
}

// The occurrences of a master's rule that start in the expanded range, minus
// excluded dates and the ones an override replaces. Generated a duration early
// (an occurrence that started before the window may still run into it) and
// with a day's slack each way for all-day dates; `overlaps` makes the call.
const generatedEntries = (
  master: ParsedEvent,
  rule: string,
  overridden: Set<number>,
  window: AgendaWindow
): AgendaEntry[] => {
  const form = timeForm(master)
  const length = durationMs(master, form)
  const from = new Date(window.start.getTime() - length - DAY_MS)
  const to = new Date(window.end.getTime() + DAY_MS)
  // The parser already resolved TZID values to UTC; a floating one is read in
  // the series' own zone, like its DTSTART.
  const excluded = new Set((master.excludedDates ?? []).map((value) => instantOf(value, form)))
  const masterStart = form.kind === 'floating' ? `${master.start}Z` : master.start
  const timeZone = form.kind === 'zoned' ? form.timeZone : undefined
  return seriesOccurrences(masterStart, rule, from, to, MAX_GENERATED, timeZone)
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

const seriesInWindow = ({ master, others, overrides }: Series, window: AgendaWindow): AgendaEntry[] => {
  const replaced = [...others.map(plainEntry), ...overrides.map((o) => overrideEntry(o, master))]
  const rule = master?.recurrence
  if (!(master && rule)) {
    return [...(master ? [plainEntry(master)] : []), ...replaced]
  }
  // A component in `others` replaces an occurrence we can't name, so expanding
  // the rule would list that occurrence a second time at its old time.
  if (others.length > 0) {
    return [{ ...plainEntry(master), unexpanded: true }, ...replaced]
  }
  const overridden = new Set(overrides.map((o) => Date.parse(o.recurrenceId ?? '')))
  let generated: AgendaEntry[]
  try {
    generated = generatedEntries(master, rule, overridden, window)
  } catch {
    // A rule rrule can't read: list the series as stored rather than drop it.
    generated = [{ ...plainEntry(master), unexpanded: true }]
  }
  return [...generated, ...replaced]
}

// The entries that overlap the window: one per occurrence for a series, each at
// its actual time; one-off events as they are.
export const windowEntries = (events: ParsedEvent[], window: AgendaWindow): AgendaEntry[] =>
  groupSeries(events)
    .flatMap((series) => seriesInWindow(series, window))
    .filter((entry) => overlaps(entry, window))
