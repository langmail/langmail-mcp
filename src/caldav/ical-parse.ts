// Minimal read-side parser for the VEVENTs we list back to the agent.
// ical-generator only *writes* iCalendar, and pulling in a full parser for
// the handful of fields list_calendar_events surfaces (uid, title, times,
// location) isn't worth it — so this extracts just those, happy-path.

// One ATTENDEE of a VEVENT, reduced to what the calendar tools need: the bare
// email (mailto: stripped) and, when the stored line carries one, the PARTSTAT
// (ACCEPTED / DECLINED / TENTATIVE / NEEDS-ACTION). Surfaced so list_calendar_events
// can show who is invited and update_calendar_event's attendee deltas can merge
// against the real stored list instead of a caller-supplied guess.
export interface ParsedAttendee {
  email: string
  status?: string
}

export interface ParsedEvent {
  // Every ATTENDEE on the VEVENT, in source order. Empty when the event has
  // none (an attendee-less personal event).
  attendees: ParsedAttendee[]
  // Free-text DESCRIPTION, unescaped. Surfaced so an attendee-delta update can
  // preserve it without the caller re-supplying it.
  description?: string
  end: string
  location?: string
  // Bare organizer email (mailto: stripped). Edits must reuse it instead of
  // the freshly discovered principal: an event created under a previous
  // account address (still an enabled alias) otherwise gets a second,
  // different ORGANIZER, which Stalwart rejects with 412
  // SameOrganizerInAllComponents.
  organizer?: string
  // Raw RRULE (e.g. `FREQ=WEEKLY;BYDAY=TH`) when the event is a recurring
  // series; absent for one-off events. Surfaced so the agent can re-supply it
  // to update_calendar_event (which re-rules the whole series).
  recurrence?: string
  start: string
  // IANA zone named by the DTSTART `;TZID=` param, when present. This is the
  // event's own zone: update_calendar_event keeps it so an edit doesn't silently
  // re-express the event elsewhere, and list rendering surfaces it. Absent for
  // the historical UTC (`…Z`) form and for foreign floating times. `start`/`end`
  // stay pure ISO wall-clock strings — the zone lives here, not appended to them.
  startTzid?: string
  title: string
  uid: string
  // How many ATTENDEE lines could NOT be reduced to a bare email (a non-mailto
  // cal-address — e.g. an Apple `urn:uuid:` with the address in an EMAIL param).
  // Present (and > 0) only when some were dropped, so update_calendar_event can
  // refuse a delta edit rather than silently drop those people. Absent when all
  // attendees parsed cleanly.
  unparsedAttendeeCount?: number
}

// RFC 5545 folds long lines with CRLF (or LF) + a single space/tab. Undo
// that before parsing so a folded value (e.g. an email) reads as one line.
const unfold = (ical: string): string => ical.replace(/\r?\n[ \t]/gu, '')

// A content line is `NAME(;PARAM=…)*:VALUE`; the name ends at the first
// `;` or `:`, the value is everything after the first `:`.
const NAME_RE = /^([^;:]+)/u
const TZID_RE = /(?:^|;)TZID=([^;:]+)/iu

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
interface ParsedProperty {
  params: string
  value: string
}

// One VEVENT's properties: the single-valued ones keyed by name (later wins),
// plus the multi-valued ATTENDEE lines collected in source order — a Map would
// clobber all but the last, and an event's whole point can be its attendee list.
interface ParsedBlock {
  attendees: ParsedProperty[]
  props: Map<string, ParsedProperty>
}

// Records one content line onto the current VEVENT block. ATTENDEE is
// multi-valued (collected in order); everything else is keyed by name, later
// wins. First-colon split: misplaces the value boundary if a property parameter
// carries a quoted ':' (e.g. CN="Org:Unit"). Of the properties we read, only
// ORGANIZER/ATTENDEE realistically carry such params (SENT-BY, display-name CNs)
// — parseOrganizerEmail / parseAttendee re-anchor on the trailing mailto: URI,
// so the mis-split stays harmless.
const recordProperty = (block: ParsedBlock, line: string): void => {
  const colon = line.indexOf(':')
  if (colon === -1) {
    return
  }
  const name = NAME_RE.exec(line.slice(0, colon))?.[1]?.toUpperCase()
  if (!name) {
    return
  }
  const property = { params: line.slice(name.length, colon), value: line.slice(colon + 1) }
  if (name === 'ATTENDEE') {
    block.attendees.push(property)
  } else {
    block.props.set(name, property)
  }
}

const eventBlocks = (ical: string): ParsedBlock[] => {
  const blocks: ParsedBlock[] = []
  let current: ParsedBlock | null = null
  // Nesting depth of sub-components inside the current VEVENT (VALARM, …).
  let nested = 0

  for (const line of unfold(ical).split(LINE_RE)) {
    if (line === 'BEGIN:VEVENT') {
      current = { attendees: [], props: new Map() }
      nested = 0
    } else if (line === 'END:VEVENT') {
      if (current) {
        blocks.push(current)
      }
      current = null
    } else if (current && line.startsWith('BEGIN:')) {
      nested += 1
    } else if (current && line.startsWith('END:')) {
      nested = Math.max(0, nested - 1)
    } else if (current && nested === 0) {
      recordProperty(current, line)
    }
  }
  return blocks
}

// Bare organizer email from a first-colon-split ORGANIZER value. The
// cal-address is the mailto: URI at the END of the content line, but params
// can smuggle colons inside quotes past the split (SENT-BY="mailto:…",
// CN="Team: Weekly"), leaving param debris in `value` — so anchor on the last
// mailto: instead of the front. A value we can't reduce to a clean bare
// address (non-mailto cal-address, leftover quotes/colons) is dropped rather
// than risk callers writing garbage back into a rebuilt invite.
const LAST_MAILTO_RE = /^.*mailto:/isu
const NOT_BARE_EMAIL_RE = /["\s:;,]/u
const parseOrganizerEmail = (property: ParsedProperty | undefined): string | undefined => {
  if (!property) {
    return
  }
  const email = property.value.replace(LAST_MAILTO_RE, '').trim()
  return email && email !== property.value.trim() && !NOT_BARE_EMAIL_RE.test(email) ? email : undefined
}

const propertyTimeZone = (property: ParsedProperty | undefined): string | undefined => {
  const timeZone = TZID_RE.exec(property?.params ?? '')?.[1]
  return timeZone ? timeZone.replace(/^"|"$/gu, '') : undefined
}

// PARTSTAT on an ATTENDEE parameter list, unquoted. The value runs to the next
// `;` (further param) or `:` (start of the value); absent on a freshly built,
// not-yet-answered attendee only when the client omits the NEEDS-ACTION default.
const PARTSTAT_RE = /(?:^|;)PARTSTAT=([^;:]+)/iu

// Bare attendee email + PARTSTAT from an ATTENDEE line. Same trailing-mailto
// anchoring as parseOrganizerEmail: params can smuggle colons past the
// first-colon split (SENT-BY, CN), so read the address off the last mailto:.
// An ATTENDEE we can't reduce to a clean bare address is dropped rather than
// surfaced as garbage or written back into a rebuilt invite.
const parseAttendee = (property: ParsedProperty): ParsedAttendee | undefined => {
  const email = property.value.replace(LAST_MAILTO_RE, '').trim()
  if (!email || email === property.value.trim() || NOT_BARE_EMAIL_RE.test(email)) {
    return
  }
  // PARTSTAT can land in `value` rather than `params` when an earlier quoted
  // parameter (e.g. CN="Team: Weekly") pushes a ':' past the first-colon split.
  // Reassemble the property (name aside) and search the parameter section — i.e.
  // everything before the trailing cal-address — so the mis-split doesn't hide it.
  const reassembled = `${property.params}:${property.value}`
  const addressAt = reassembled.toLowerCase().lastIndexOf('mailto:')
  const paramSection = addressAt === -1 ? reassembled : reassembled.slice(0, addressAt)
  const status = PARTSTAT_RE.exec(paramSection)?.[1]?.replace(/^"|"$/gu, '')
  return status ? { email, status } : { email }
}

// Parses every VEVENT in a VCALENDAR. Blocks without a UID are skipped —
// an event we can't address with update/delete isn't useful to list.
export const parseEvents = (ical: string): ParsedEvent[] => {
  const events: ParsedEvent[] = []
  for (const block of eventBlocks(ical)) {
    const uid = block.props.get('UID')
    if (!uid?.value) {
      continue
    }
    const description = block.props.get('DESCRIPTION')?.value
    const location = block.props.get('LOCATION')?.value
    const organizer = parseOrganizerEmail(block.props.get('ORGANIZER'))
    const start = block.props.get('DTSTART')
    const startTzid = propertyTimeZone(start)
    // Trim so a server that emits a trailing space (`RRULE:FREQ=WEEKLY `) doesn't
    // leak it into the listed `repeats:` value.
    const recurrence = block.props.get('RRULE')?.value.trim()
    const attendees = block.attendees.map(parseAttendee).filter((a): a is ParsedAttendee => a !== undefined)
    const unparsedAttendeeCount = block.attendees.length - attendees.length
    events.push({
      attendees,
      end: icalDateToIso(block.props.get('DTEND')?.value ?? ''),
      start: icalDateToIso(start?.value ?? ''),
      title: unescapeText(block.props.get('SUMMARY')?.value ?? ''),
      uid: uid.value,
      ...(description ? { description: unescapeText(description) } : {}),
      ...(location ? { location: unescapeText(location) } : {}),
      ...(organizer ? { organizer } : {}),
      ...(recurrence ? { recurrence } : {}),
      ...(startTzid ? { startTzid } : {}),
      ...(unparsedAttendeeCount > 0 ? { unparsedAttendeeCount } : {}),
    })
  }
  return events
}
