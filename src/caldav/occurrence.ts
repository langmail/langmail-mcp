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

import { icalDateToIso } from './ical-parse.ts'

const CRLF = '\r\n'
// Line break between content lines (CRLF, bare CR, or LF). Output is always
// re-joined with CRLF (RFC 5545 §3.1); folded continuation lines keep their
// leading space and so survive the round-trip.
const LINE_RE = /\r\n|\r|\n/u

// A RECURRENCE-ID content line, with optional parameters (e.g. `;VALUE=DATE`,
// `;TZID=…`), capturing the value after the first colon. Datetime values are
// short and never folded, so a single physical line is enough.
const RECURRENCE_ID_RE = /^RECURRENCE-ID(?:;[^:]*)?:(.*)$/u
const METHOD_RE = /^METHOD:/iu

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
// our own overrides dedup regardless of millisecond formatting. NOTE: a value a
// foreign client wrote with an explicit `;TZID=` is read here as UTC (we don't
// resolve VTIMEZONE), so dedup holds under the service's "events are UTC"
// invariant — which is all our create/update tools ever emit.
const recurrenceIdMs = (component: Component): number | null => {
  for (const line of component.lines) {
    const match = RECURRENCE_ID_RE.exec(line)
    if (match) {
      const ms = Date.parse(icalDateToIso((match[1] ?? '').trim()))
      return Number.isNaN(ms) ? null : ms
    }
  }
  return null
}

// Pulls the sole VEVENT out of a freshly built override VCALENDAR (buildInvite
// output). It always contains exactly one; anything else is a programmer error.
const overrideVevent = (overrideIcal: string): string[] => {
  const vevent = splitCalendar(overrideIcal).components.find((c) => c.name === 'VEVENT')
  if (!vevent) {
    throw new Error('override iCalendar has no VEVENT')
  }
  return vevent.lines
}

// Merges `overrideIcal`'s VEVENT into the stored `masterIcal`, returning the
// combined VCALENDAR to PUT back. The master and every unrelated occurrence are
// preserved verbatim (only the line endings are normalized to CRLF); any prior
// override for the same instant is replaced so the object never carries two
// VEVENTs with the same RECURRENCE-ID; and a METHOD:REQUEST is guaranteed on
// the result — stored objects may drop it, but it's what triggers Stalwart's
// scheduling.
export const spliceOccurrenceOverride = (masterIcal: string, overrideIcal: string, recurrenceId: string): string => {
  const master = splitCalendar(masterIcal)
  const overrideLines = overrideVevent(overrideIcal)
  const targetMs = new Date(recurrenceId).getTime()

  const kept = master.components.filter((c) => !(c.name === 'VEVENT' && recurrenceIdMs(c) === targetMs))

  // The header's last line is END:VCALENDAR; everything before it is the
  // calendar-level property block we re-emit. Force METHOD:REQUEST: stored
  // objects usually carry none, and a stray METHOD:PUBLISH/CANCEL would keep
  // Stalwart from scheduling the iMIP update we're issuing.
  const end = master.header.at(-1) ?? 'END:VCALENDAR'
  const props = master.header.slice(0, -1).filter((l) => !METHOD_RE.test(l))
  const withMethod = [props[0] ?? 'BEGIN:VCALENDAR', 'METHOD:REQUEST', ...props.slice(1)]

  return [...withMethod, ...kept.flatMap((c) => c.lines), ...overrideLines, end].join(CRLF) + CRLF
}
