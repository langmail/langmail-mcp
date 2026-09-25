// Splices a single-occurrence override into a recurring calendar object.
//
// A recurring event and its per-occurrence overrides share one UID and live in
// a single calendar object (RFC 5545 §3.8.4.4): the master VEVENT holds the
// RRULE; each override VEVENT carries a RECURRENCE-ID naming the instance it
// replaces. Editing one occurrence therefore means adding (or replacing) an
// override VEVENT while leaving the master — and every other occurrence —
// exactly as stored, then PUTting the whole object back so Stalwart's
// server-side scheduler (RFC 6638) diffs it and fans out an iMIP REQUEST scoped
// to that instance.
//
// Pure string in/out (no live server), so the merge is unit-testable — the same
// shape as rsvp.ts and ical-parse.ts.

import { icalDateToIso, parseWallClockInZone } from '@langmail/ical'

import { maxSequence } from './ical.ts'
import { toIcalUtc } from './recurrence.ts'

const CRLF = '\r\n'
// Line break between content lines (CRLF, bare CR, or LF). Output is always
// re-joined with CRLF (RFC 5545 §3.1); folded continuation lines keep their
// leading space and so survive the round-trip.
const LINE_RE = /\r\n|\r|\n/u

// A RECURRENCE-ID content line, with optional parameters (e.g. `;VALUE=DATE`,
// `;TZID=…`), capturing the value after the first colon. Datetime values are
// short and never folded, so a single physical line is enough.
const RECURRENCE_ID_RE = /^RECURRENCE-ID(?:;[^:]*)?:(.*)$/u
const TZID_RE = /(?:^|;)TZID=([^;:]+)/iu
const METHOD_RE = /^METHOD:/iu
const VTIMEZONE_TZID_RE = /^TZID:(.*)$/iu
// An EXDATE content line, capturing the (possibly comma-separated) values after
// the first colon. Like RECURRENCE-ID above, our own single-instant EXDATEs are
// short and never folded, so one physical line is enough.
const EXDATE_RE = /^EXDATE(?:;[^:]*)?:(.*)$/u
const SEQUENCE_RE = /^SEQUENCE:/u
const RRULE_RE = /^RRULE[:;]/iu

// A top-level VCALENDAR component (VEVENT, VTIMEZONE, …) as its raw lines,
// BEGIN/END inclusive. Nested sub-components (e.g. VALARM inside a VEVENT) stay
// within `lines`; only the outermost BEGIN/END delimits a component.
interface Component {
  lines: string[]
  name: string
}

interface SplitCalendar {
  // Top-level components in source order.
  components: Component[]
  // Calendar-level lines outside any component, in source order: the opening
  // `BEGIN:VCALENDAR`, its properties (VERSION, PRODID, METHOD, …) and the
  // trailing `END:VCALENDAR`.
  header: string[]
}

// Separates a VCALENDAR into its calendar-level header lines and its top-level
// components, tracking BEGIN/END depth so a nested VALARM never ends a VEVENT
// early. Blank lines are dropped (iCalendar has none; a trailing newline would
// otherwise leak an empty line back on re-join).
const splitCalendar = (ical: string): SplitCalendar => {
  const header: string[] = []
  const components: Component[] = []
  let current: Component | null = null
  let depth = 0

  for (const line of ical.split(LINE_RE)) {
    if (line === '') {
      continue
    }
    if (current) {
      current.lines.push(line)
      if (line.startsWith('BEGIN:')) {
        depth += 1
      } else if (line.startsWith('END:')) {
        depth -= 1
        if (depth === 0) {
          components.push(current)
          current = null
        }
      }
      continue
    }
    if (line.startsWith('BEGIN:') && line !== 'BEGIN:VCALENDAR') {
      current = { lines: [line], name: line.slice('BEGIN:'.length) }
      depth = 1
      continue
    }
    header.push(line)
  }
  return { components, header }
}

// The RECURRENCE-ID of a component as an epoch-ms instant, or null when it has
// none (the master) or the value can't be parsed. Comparison is by instant so
// overrides dedup even when serialized with `TZID` wall-clock digits.
const recurrenceIdMs = (component: Component): number | null => {
  for (const line of component.lines) {
    const match = RECURRENCE_ID_RE.exec(line)
    if (match) {
      const iso = icalDateToIso((match[1] ?? '').trim())
      const timeZone = TZID_RE.exec(line)?.[1]?.replace(/^"|"$/gu, '')
      const ms = timeZone && !iso.endsWith('Z') ? parseWallClockInZone(iso, timeZone).getTime() : Date.parse(iso)
      return Number.isNaN(ms) ? null : ms
    }
  }
  return null
}

// Pulls the sole VEVENT out of a freshly built override VCALENDAR (buildInvite
// output). It always contains exactly one; anything else is a programmer error.
const overrideVevent = (override: SplitCalendar): Component => {
  const vevent = override.components.find((c) => c.name === 'VEVENT')
  if (!vevent) {
    throw new Error('override iCalendar has no VEVENT')
  }
  return vevent
}

// The start of an ATTENDEE content line. Only a physical line's start matches —
// folded continuations keep their leading space and never do.
const ATTENDEE_LINE_RE = /^ATTENDEE[;:]/iu

// Only the VEVENT's own ATTENDEE lines count: an EMAIL VALARM carries its
// recipient as an ATTENDEE too, and that is no one to schedule.
const veventHasAttendee = (lines: string[]): boolean => {
  let depth = 0
  for (const line of lines) {
    if (line.startsWith('BEGIN:')) {
      depth += 1
    } else if (line.startsWith('END:')) {
      depth -= 1
    } else if (depth === 1 && ATTENDEE_LINE_RE.test(line)) {
      return true
    }
  }
  return false
}

const hasAttendee = (components: Component[]): boolean =>
  components.some((c) => c.name === 'VEVENT' && veventHasAttendee(c.lines))

// Re-emits the calendar-level property block (everything before END:VCALENDAR).
// METHOD:REQUEST is forced when the object still names an attendee: stored
// objects usually carry no METHOD, and a stray METHOD:PUBLISH/CANCEL would keep
// Stalwart from scheduling the iMIP update we're issuing. With zero ATTENDEEs
// there is nobody to schedule — and RFC 5546 forbids a REQUEST without one — so
// any METHOD is dropped instead (mirrors buildInvite for personal events).
const calendarPropertyLines = (header: string[], components: Component[]): string[] => {
  const [begin = 'BEGIN:VCALENDAR', ...rest] = header.slice(0, -1).filter((l) => !METHOD_RE.test(l))
  return hasAttendee(components) ? [begin, 'METHOD:REQUEST', ...rest] : [begin, ...rest]
}

const componentKey = (component: Component): string => {
  if (component.name === 'VTIMEZONE') {
    const tzid = component.lines.find((line) => VTIMEZONE_TZID_RE.test(line))
    return `VTIMEZONE:${VTIMEZONE_TZID_RE.exec(tzid ?? '')?.[1] ?? ''}`
  }
  return `${component.name}:${component.lines.join('\n')}`
}

// Merges `overrideIcal`'s VEVENT into the stored `masterIcal`, returning the
// combined VCALENDAR to PUT back. The master and every unrelated occurrence are
// preserved verbatim (only the line endings are normalized to CRLF); any prior
// override for the same instant is replaced so the object never carries two
// VEVENTs with the same RECURRENCE-ID; and a METHOD:REQUEST is guaranteed on
// the result whenever it still names an attendee — stored objects may drop it,
// but it's what triggers Stalwart's scheduling. An attendee-less (personal)
// series gets no METHOD at all (see calendarPropertyLines).
export const spliceOccurrenceOverride = (masterIcal: string, overrideIcal: string, recurrenceId: string): string => {
  const master = splitCalendar(masterIcal)
  const override = splitCalendar(overrideIcal)
  const overrideEvent = overrideVevent(override)
  const targetMs = new Date(recurrenceId).getTime()

  const kept = master.components.filter((c) => !(c.name === 'VEVENT' && recurrenceIdMs(c) === targetMs))
  const keptKeys = new Set(kept.map(componentKey))
  const missingOverrideComponents = override.components.filter(
    (c) => c.name !== 'VEVENT' && !keptKeys.has(componentKey(c))
  )
  const components = [...kept, ...missingOverrideComponents, overrideEvent]
  const orderedComponents = [
    ...components.filter((c) => c.name !== 'VEVENT'),
    ...components.filter((c) => c.name === 'VEVENT'),
  ]

  // The header's last line is END:VCALENDAR; everything before it is the
  // calendar-level property block we re-emit (with METHOD handled there).
  const end = master.header.at(-1) ?? 'END:VCALENDAR'
  const head = calendarPropertyLines(master.header, orderedComponents)

  return [...head, ...orderedComponents.flatMap((c) => c.lines), end].join(CRLF) + CRLF
}

// The master VEVENT of a recurring object carries the RRULE and is not itself an
// override (no RECURRENCE-ID) — RFC 5545 §3.8.4.4. Both conditions matter: an
// EXDATE only excludes instances of a component that actually has the RRULE, so
// the target must be the rule-bearing VEVENT, never a stray or an override.
const isMaster = (component: Component): boolean =>
  component.name === 'VEVENT' && recurrenceIdMs(component) === null && component.lines.some((l) => RRULE_RE.test(l))

// True when the master already carries an EXDATE for `targetMs`. Comparison is
// by instant (same UTC invariant as recurrenceIdMs) so a re-cancel is detected
// regardless of value formatting. EXDATE is multi-valued (RFC 5545 §3.8.5.1),
// so each comma-separated instant on the line is checked.
const masterExcludes = (master: Component, targetMs: number): boolean => {
  for (const line of master.lines) {
    const match = EXDATE_RE.exec(line)
    if (!match) {
      continue
    }
    for (const value of (match[1] ?? '').split(',')) {
      const ms = Date.parse(icalDateToIso(value.trim()))
      if (!Number.isNaN(ms) && ms === targetMs) {
        return true
      }
    }
  }
  return false
}

// Rewrites the master's lines to exclude one instant: replace its SEQUENCE line
// with the bumped value (or add one when the master carried none) and splice the
// EXDATE in just before END:VEVENT. Every other line is preserved verbatim.
const excludeInstant = (lines: string[], exdate: string, sequence: number): string[] => {
  let sequenceSeen = false
  const rewritten = lines.map((line) => {
    if (SEQUENCE_RE.test(line)) {
      sequenceSeen = true
      return `SEQUENCE:${sequence}`
    }
    return line
  })
  // splitCalendar keeps the component BEGIN/END inclusive, so the last line is
  // END:VEVENT; insert the new content lines before it.
  const endIndex = rewritten.length - 1
  const inserts = sequenceSeen ? [exdate] : [`SEQUENCE:${sequence}`, exdate]
  return [...rewritten.slice(0, endIndex), ...inserts, ...rewritten.slice(endIndex)]
}

// Removes a single occurrence from a stored recurring object by excluding its
// instant on the master, returning the combined VCALENDAR to PUT back. The
// master keeps its RRULE and every unrelated occurrence verbatim (only line
// endings normalize to CRLF); a new EXDATE names the cancelled instant and the
// master's SEQUENCE bumps past every SEQUENCE in the object so attendee clients
// treat the re-scheduled series as newer and re-apply it — dropping just that
// instance (RFC 5546; Stalwart delivers the exclusion as an updated-series
// REQUEST carrying the EXDATE, not a per-instance CANCEL); any override VEVENT
// for the same instant is dropped so no orphan dangles beside the EXDATE; and a
// METHOD:REQUEST is guaranteed whenever the object still names an attendee —
// what triggers Stalwart's scheduling on PUT (an attendee-less personal series
// gets no METHOD; see calendarPropertyLines).
//
// Idempotent: if the master already excludes the instant (a double-cancel), the
// input is returned unchanged so the caller can skip the PUT (no scheduling diff)
// while still reporting success.
// `allDay` marks a master whose DTSTART is a DATE: the EXDATE must then be a
// DATE too (RFC 5545 §3.8.5.1 — the value type of DTSTART).
export const spliceOccurrenceCancellation = (masterIcal: string, recurrenceId: string, allDay = false): string => {
  const calendar = splitCalendar(masterIcal)
  const targetMs = new Date(recurrenceId).getTime()

  // The caller only reaches here after confirming the object is a recurring
  // series, so a missing rule-bearing master is a real invariant violation.
  // Surface it loudly rather than PUT an object with no EXDATE added and falsely
  // report the occurrence cancelled (same fail-loud stance as overrideVevent).
  const master = calendar.components.find(isMaster)
  if (!master) {
    throw new Error('spliceOccurrenceCancellation: no recurring master VEVENT (one with an RRULE) found')
  }
  if (masterExcludes(master, targetMs)) {
    return masterIcal
  }

  const sequence = maxSequence(masterIcal) + 1
  const exdate = allDay
    ? `EXDATE;VALUE=DATE:${toIcalUtc(recurrenceId).slice(0, 8)}`
    : `EXDATE:${toIcalUtc(recurrenceId)}`
  const components = calendar.components
    // Drop any prior override for the cancelled instant.
    .filter((c) => !(c.name === 'VEVENT' && recurrenceIdMs(c) === targetMs))
    // Exclude the instant on the master (identity compare — master survives the
    // filter above, since its recurrenceIdMs is null, not targetMs).
    .map((c) => (c === master ? { ...c, lines: excludeInstant(c.lines, exdate, sequence) } : c))

  const end = calendar.header.at(-1) ?? 'END:VCALENDAR'
  const head = calendarPropertyLines(calendar.header, components)

  return [...head, ...components.flatMap((c) => c.lines), end].join(CRLF) + CRLF
}

const BEGIN_VALARM_RE = /^BEGIN:VALARM\s*$/iu
const BEGIN_LINE_RE = /^BEGIN:/iu
const END_LINE_RE = /^END:/iu
const SUMMARY_LINE_RE = /^SUMMARY(?:;[^:]*)?:(.*)$/iu

// A VEVENT's lines with every top-level VALARM removed, and its SUMMARY value
// (still TEXT-escaped, folds joined) for the replacement alarm's DESCRIPTION.
const stripAlarms = (lines: string[]): { kept: string[]; summary: string } => {
  const kept: string[] = []
  let summary = ''
  let depth = 0
  let skipping = false
  let inSummary = false
  for (const line of lines) {
    if (inSummary && (line.startsWith(' ') || line.startsWith('\t'))) {
      summary += line.slice(1)
      kept.push(line)
      continue
    }
    inSummary = false
    if (BEGIN_LINE_RE.test(line)) {
      depth += 1
      skipping ||= depth === 2 && BEGIN_VALARM_RE.test(line)
    }
    if (!skipping) {
      kept.push(line)
      const match = depth === 1 ? SUMMARY_LINE_RE.exec(line) : null
      if (match) {
        summary = match[1] ?? ''
        inSummary = true
      }
    }
    if (END_LINE_RE.test(line)) {
      depth -= 1
      skipping &&= depth >= 2
    }
  }
  return { kept, summary }
}

// Replaces the reminders on every VEVENT of a stored object — the master and
// any overrides — with one DISPLAY alarm `minutesBefore` the start, or none
// when `minutesBefore` is null. Every other line is kept verbatim: no SEQUENCE
// bump, no rebuilt ATTENDEEs, so attendee responses survive and nobody is
// re-invited over what is the organizer's own reminder.
export const spliceAlarms = (ical: string, minutesBefore: number | null): string => {
  const calendar = splitCalendar(ical)
  const components = calendar.components.map((c) => {
    if (c.name !== 'VEVENT') {
      return c
    }
    const { kept, summary } = stripAlarms(c.lines)
    if (minutesBefore === null) {
      return { ...c, lines: kept }
    }
    const alarm = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:${minutesBefore === 0 ? 'PT0S' : `-PT${minutesBefore}M`}`,
      `DESCRIPTION:${summary || 'Reminder'}`,
      'END:VALARM',
    ]
    return { ...c, lines: [...kept.slice(0, -1), ...alarm, ...kept.slice(-1)] }
  })
  const end = calendar.header.at(-1) ?? 'END:VCALENDAR'
  return [...calendar.header.slice(0, -1), ...components.flatMap((c) => c.lines), end].join(CRLF) + CRLF
}
