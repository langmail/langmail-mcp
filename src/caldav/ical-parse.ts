// Minimal read-side parser for the VEVENTs we list back to the agent.
// ical-generator only *writes* iCalendar, and pulling in a full parser for
// the handful of fields list_calendar_events surfaces (uid, title, times,
// location) isn't worth it — so this extracts just those, happy-path.

export interface ParsedEvent {
  end: string
  location?: string
  // Raw RRULE (e.g. `FREQ=WEEKLY;BYDAY=TH`) when the event is a recurring
  // series; absent for one-off events. Surfaced so the agent can re-supply it
  // to update_calendar_event (which re-rules the whole series).
  recurrence?: string
  start: string
  title: string
  uid: string
}

// RFC 5545 folds long lines with CRLF (or LF) + a single space/tab. Undo
// that before parsing so a folded value (e.g. an email) reads as one line.
const unfold = (ical: string): string => ical.replace(/\r?\n[ \t]/gu, '')

// A content line is `NAME(;PARAM=…)*:VALUE`; the name ends at the first
// `;` or `:`, the value is everything after the first `:`.
const NAME_RE = /^([^;:]+)/u

// Line break between content lines (CRLF or bare LF).
const LINE_RE = /\r?\n/u

// Reverses RFC 5545 TEXT escaping for display (\\ \, \; \n) in a single
// pass, so an escaped backslash (`\\`) isn't re-read as a newline.
const ESCAPE_RE = /\\([\\;,nN])/gu
const unescapeText = (value: string): string =>
  value.replace(ESCAPE_RE, (_match, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch))

// `20260612T100000Z` / `20260612` → ISO 8601 for display. Anything else
// (already-ISO, or an exotic form) is returned untouched.
const ICAL_DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u

export const icalDateToIso = (value: string): string => {
  const m = ICAL_DT_RE.exec(value)
  if (!m) {
    return value
  }
  const [, y, mo, d, h, mi, s, z] = m
  if (!h) {
    return `${y}-${mo}-${d}`
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${z ?? ''}`
}

// Splits a serialized VCALENDAR into one record per VEVENT, keyed by
// property name (uppercased). Later occurrences of a property win, which
// is fine for the single-valued fields we read. Properties of nested
// sub-components (notably VALARM, whose SUMMARY would otherwise clobber the
// event's) are skipped.
const eventBlocks = (ical: string): Map<string, string>[] => {
  const blocks: Map<string, string>[] = []
  let current: Map<string, string> | null = null
  // Nesting depth of sub-components inside the current VEVENT (VALARM, …).
  let nested = 0

  for (const line of unfold(ical).split(LINE_RE)) {
    if (line === 'BEGIN:VEVENT') {
      current = new Map()
      nested = 0
      continue
    }
    if (line === 'END:VEVENT') {
      if (current) {
        blocks.push(current)
      }
      current = null
      continue
    }
    if (!current) {
      continue
    }
    if (line.startsWith('BEGIN:')) {
      nested += 1
      continue
    }
    if (line.startsWith('END:')) {
      nested = Math.max(0, nested - 1)
      continue
    }
    if (nested > 0) {
      continue
    }
    // First-colon split: misplaces the value boundary if a property
    // parameter carries a quoted ':' (e.g. CN="Org:Unit"). The properties
    // we read (UID/SUMMARY/DTSTART/DTEND/LOCATION) don't use such params, so
    // this stays correct within the parser's happy-path scope.
    const colon = line.indexOf(':')
    if (colon === -1) {
      continue
    }
    const name = NAME_RE.exec(line.slice(0, colon))?.[1]?.toUpperCase()
    if (name) {
      current.set(name, line.slice(colon + 1))
    }
  }
  return blocks
}

// Parses every VEVENT in a VCALENDAR. Blocks without a UID are skipped —
// an event we can't address with update/delete isn't useful to list.
export const parseEvents = (ical: string): ParsedEvent[] => {
  const events: ParsedEvent[] = []
  for (const block of eventBlocks(ical)) {
    const uid = block.get('UID')
    if (!uid) {
      continue
    }
    const location = block.get('LOCATION')
    // Trim so a server that emits a trailing space (`RRULE:FREQ=WEEKLY `) doesn't
    // leak it into the listed `repeats:` value.
    const recurrence = block.get('RRULE')?.trim()
    events.push({
      end: icalDateToIso(block.get('DTEND') ?? ''),
      start: icalDateToIso(block.get('DTSTART') ?? ''),
      title: unescapeText(block.get('SUMMARY') ?? ''),
      uid,
      ...(location ? { location: unescapeText(location) } : {}),
      ...(recurrence ? { recurrence } : {}),
    })
  }
  return events
}
