// Minimal read-side parser for the VEVENTs we list back to the agent.
// ical-generator only *writes* iCalendar, and pulling in a full parser for
// the handful of fields list_calendar_events surfaces (uid, title, times,
// location) isn't worth it — so this extracts just those, happy-path.

import { parseWallClockInZone } from './timezone.ts'

// One ATTENDEE of a VEVENT, reduced to what the calendar tools and contact
// collection need: the bare email (mailto: stripped), the CN display name
// when the stored line carries one — the pairing of a name with an address
// is exactly what contact collection feeds on — the PARTSTAT
// (ACCEPTED / DECLINED / TENTATIVE / NEEDS-ACTION) and the ROLE
// (REQ-PARTICIPANT / OPT-PARTICIPANT / CHAIR / NON-PARTICIPANT). Surfaced so
// list_calendar_events can show who is invited and update_calendar_event can
// merge against the real stored list and keep each attendee's reply across a
// rebuild instead of resetting it.
export interface ParsedAttendee {
  email: string
  name?: string
  role?: string
  status?: string
}

// One VALARM of a VEVENT (RFC 5545 §3.6.6). `lines` are its unfolded content
// lines, BEGIN/END inclusive, exactly as stored: update_calendar_event splices
// them back verbatim into a rebuilt VEVENT, so an alarm of any shape (EMAIL,
// AUDIO, an absolute trigger, vendor X- properties) survives an edit without
// being re-serialized from the handful of fields read here. `trigger` is the
// TRIGGER value (`-PT30M`, `20261002T090000Z`) and `triggerParams` its raw
// parameter list (`;VALUE=DATE-TIME`, `;RELATED=END`), for display.
export interface ParsedAlarm {
  action?: string
  lines: string[]
  trigger?: string
  triggerParams?: string
}

type ShowAs = 'busy' | 'free'

export interface ParsedEvent {
  // VALARMs nested in the VEVENT, in source order. Present (and non-empty) only
  // when the VEVENT carries any.
  alarms?: ParsedAlarm[]
  // True when DTSTART is a DATE rather than a DATE-TIME (`DTSTART;VALUE=DATE`):
  // an all-day event. `start`/`end` are then date-only ISO strings
  // (`2026-10-03`), and `end` is exclusive — the day after the last day
  // (RFC 5545 §3.6.1). Absent on timed events.
  allDay?: true
  // Every ATTENDEE on the VEVENT, in source order. Empty when the event has
  // none (an attendee-less personal event).
  attendees: ParsedAttendee[]
  // CLASS (RFC 5545 §3.8.1.3), uppercased: `PUBLIC`, `PRIVATE` or
  // `CONFIDENTIAL`. Absent when the VEVENT carries none, which means public.
  classification?: string
  // Free-text DESCRIPTION, unescaped. Surfaced so an attendee-delta update can
  // preserve it without the caller re-supplying it.
  description?: string
  // DURATION as stored (`PT1H`), when the VEVENT gives its length that way
  // instead of with a DTEND (RFC 5545 §3.8.2.5).
  duration?: string
  end: string
  // Instants the series excludes (EXDATE), as stored — how delete_calendar_event
  // cancels a single occurrence. Present (and non-empty) only when the VEVENT
  // carries any. update_calendar_event refuses to rebuild such a master, because
  // a rebuilt VEVENT carries no EXDATE and would resurrect the cancellation.
  excludedDates?: string[]
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
  // The instant this VEVENT overrides, as a UTC ISO string, when it is a
  // per-occurrence override (RFC 5545 §3.8.4.4); absent on the master and on
  // one-off events. Normalized to an instant — the stored RECURRENCE-ID may
  // carry a TZID — so update_calendar_event can find the override for the
  // occurrence it is editing and merge omitted fields against *its* stored
  // state rather than the master's.
  recurrenceId?: string
  // Whether the event counts as busy time, from TRANSP (RFC 5545 §3.8.2.7):
  // OPAQUE is `busy`, TRANSPARENT is `free`. Absent when the VEVENT carries no
  // TRANSP or an unrecognised value; consumers then treat it as busy, the
  // RFC's default.
  showAs?: ShowAs
  start: string
  // IANA zone named by the DTSTART `;TZID=` param, when present. This is the
  // event's own zone: update_calendar_event keeps it so an edit doesn't silently
  // re-express the event elsewhere, and list rendering surfaces it. Absent for
  // the historical UTC (`…Z`) form, for foreign floating times, and for an
  // all-day DATE (some producers write a TZID beside it, but a date has no wall
  // clock for a zone to govern). `start`/`end`
  // stay pure ISO wall-clock strings — the zone lives here, not appended to them.
  startTzid?: string
  // STATUS (RFC 5545 §3.8.1.11), uppercased: `CONFIRMED`, `TENTATIVE` or
  // `CANCELLED`. Absent when the VEVENT carries none.
  status?: string
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
  // Raw VALARM sub-components, each as its content lines (BEGIN/END inclusive).
  alarms: string[][]
  attendees: ParsedProperty[]
  // EXDATE is multi-valued twice over — it may repeat, and each line may carry
  // a comma-separated list (RFC 5545 §3.8.5.1) — so it is collected like
  // ATTENDEE rather than keyed.
  exdates: ParsedProperty[]
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
  } else if (name === 'EXDATE') {
    block.exdates.push(property)
  } else {
    block.props.set(name, property)
  }
}

// Scanner state while walking one VCALENDAR's lines.
interface ScanState {
  // The top-level VALARM being collected, if any; everything nested inside it
  // belongs to it verbatim.
  alarm: string[] | null
  blocks: ParsedBlock[]
  current: ParsedBlock | null
  // Nesting depth of sub-components inside the current VEVENT (VALARM, …).
  nested: number
}

// Component delimiters. Names are case-insensitive (RFC 5545 §3.1), and some
// producers emit lowercase ones.
const BEGIN_RE = /^BEGIN:/iu
const END_RE = /^END:/iu
const BEGIN_VALARM_RE = /^BEGIN:VALARM\s*$/iu
const BEGIN_VEVENT_RE = /^BEGIN:VEVENT\s*$/iu
const END_VEVENT_RE = /^END:VEVENT\s*$/iu

// A sub-component line (BEGIN:/END:/property) inside the current VEVENT. Only
// VALARMs are kept, as raw lines; any other sub-component is skipped.
const scanNestedLine = (state: ScanState, block: ParsedBlock, line: string): void => {
  if (BEGIN_RE.test(line)) {
    if (state.nested === 0 && BEGIN_VALARM_RE.test(line)) {
      state.alarm = []
    }
    state.alarm?.push(line)
    state.nested += 1
    return
  }
  if (END_RE.test(line)) {
    state.alarm?.push(line)
    state.nested = Math.max(0, state.nested - 1)
    if (state.nested === 0 && state.alarm) {
      block.alarms.push(state.alarm)
      state.alarm = null
    }
    return
  }
  if (line !== '') {
    state.alarm?.push(line)
  }
}

const scanLine = (state: ScanState, line: string): void => {
  if (BEGIN_VEVENT_RE.test(line)) {
    state.current = { alarms: [], attendees: [], exdates: [], props: new Map() }
    state.nested = 0
    state.alarm = null
    return
  }
  if (END_VEVENT_RE.test(line)) {
    if (state.current) {
      state.blocks.push(state.current)
    }
    state.current = null
    return
  }
  if (!state.current) {
    return
  }
  if (state.nested === 0 && !BEGIN_RE.test(line) && !END_RE.test(line)) {
    recordProperty(state.current, line)
    return
  }
  scanNestedLine(state, state.current, line)
}

const eventBlocks = (ical: string): ParsedBlock[] => {
  const state: ScanState = { alarm: null, blocks: [], current: null, nested: 0 }
  for (const line of unfold(ical).split(LINE_RE)) {
    scanLine(state, line)
  }
  return state.blocks
}

// The ACTION and TRIGGER of a raw VALARM, read off its own top-level lines.
const ALARM_PROPERTY_RE = /^(ACTION|TRIGGER)((?:;[^:]*)?):(.*)$/iu
const parseAlarm = (lines: string[]): ParsedAlarm => {
  const alarm: ParsedAlarm = { lines }
  for (const line of lines) {
    const match = ALARM_PROPERTY_RE.exec(line)
    if (!match) {
      continue
    }
    const [, name = '', params = '', value = ''] = match
    if (name.toUpperCase() === 'ACTION') {
      alarm.action = value.trim().toUpperCase()
    } else {
      alarm.trigger = value.trim()
      if (params) {
        alarm.triggerParams = params
      }
    }
  }
  return alarm
}

// Bare organizer email from a first-colon-split ORGANIZER value. The
// cal-address is the mailto: URI at the END of the content line, but params
// can smuggle colons inside quotes past the split (SENT-BY="mailto:…",
// CN="Team: Weekly"), leaving param debris in `value` — so anchor on the last
// mailto: instead of the front. A value we can't reduce to a clean bare
// address (non-mailto cal-address, leftover quotes/colons) is dropped rather
// than risk callers writing garbage back into a rebuilt invite.
// Greedy by design: the real cal-address is the LAST mailto: on the line,
// after any params. The cost is that a param value containing the literal
// text `mailto:` (e.g. CN="Reply to mailto:me@x.com instead") strips
// through that occurrence and yields a wrong address — accepted, since the
// alternative (parsing quoted params properly) is a full RFC 5545 lexer
// for a case no server we talk to emits.
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

// A RECURRENCE-ID value reduced to a UTC ISO instant. The stored value is
// either a UTC date-time, a date-only value, or wall-clock digits qualified by
// a TZID param — all three have to compare equal to the caller's ISO instant,
// so they are resolved here rather than surfaced raw. An unparsable value is
// dropped (the VEVENT then reads as a plain event, which is the safe default).
const parseRecurrenceInstant = (property: ParsedProperty | undefined): string | undefined => {
  if (!property) {
    return
  }
  const iso = icalDateToIso(property.value.trim())
  const timeZone = propertyTimeZone(property)
  let at: Date
  try {
    at = timeZone && !iso.endsWith('Z') ? parseWallClockInZone(iso, timeZone) : new Date(iso)
  } catch {
    return
  }
  // Re-wrap as a plain Date: parseWallClockInZone returns a TZDate, whose
  // toISOString() keeps the zone offset instead of normalizing to UTC.
  return Number.isNaN(at.getTime()) ? undefined : new Date(at.getTime()).toISOString()
}

// PARTSTAT on an ATTENDEE parameter list, unquoted. The value runs to the next
// `;` (further param) or `:` (start of the value); absent on a freshly built,
// not-yet-answered attendee only when the client omits the NEEDS-ACTION default.
const PARTSTAT_RE = /(?:^|;)PARTSTAT=([^;:]+)/iu

// ROLE on an ATTENDEE parameter list, same shape as PARTSTAT.
const ROLE_RE = /(?:^|;)ROLE=([^;:]+)/iu

// CN on an ATTENDEE parameter list: quoted (CN="Fairweather, Robin" — commas,
// semicolons, and colons are legal inside the quotes) or unquoted (CN=Robin,
// value runs to the next `;` or `:`).
const CN_RE = /(?:^|;)CN=(?:"([^"]*)"|([^;:]+))/iu

// Bare attendee email + CN + PARTSTAT + ROLE from an ATTENDEE line. Same
// trailing-mailto anchoring as parseOrganizerEmail: params can smuggle colons
// past the first-colon split (SENT-BY, CN), so read the address off the last
// mailto:. An ATTENDEE we can't reduce to a clean bare address is dropped
// rather than surfaced as garbage or written back into a rebuilt invite.
const parseAttendee = (property: ParsedProperty): ParsedAttendee | undefined => {
  const email = property.value.replace(LAST_MAILTO_RE, '').trim()
  if (!email || email === property.value.trim() || NOT_BARE_EMAIL_RE.test(email)) {
    return
  }
  // Params can land in `value` rather than `params` when an earlier quoted
  // parameter (e.g. CN="Team: Weekly") pushes a ':' past the first-colon split.
  // Reassemble the property (name aside) and search the parameter section — i.e.
  // everything before the trailing cal-address — so the mis-split doesn't hide it.
  const reassembled = `${property.params}:${property.value}`
  const addressAt = reassembled.toLowerCase().lastIndexOf('mailto:')
  const paramSection = addressAt === -1 ? reassembled : reassembled.slice(0, addressAt)
  const status = PARTSTAT_RE.exec(paramSection)?.[1]?.replace(/^"|"$/gu, '')
  const role = ROLE_RE.exec(paramSection)?.[1]?.replace(/^"|"$/gu, '')
  const cnMatch = CN_RE.exec(paramSection)
  const name = (cnMatch?.[1] ?? cnMatch?.[2])?.trim()
  return {
    email,
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  }
}

// Flattens the EXDATE lines of one VEVENT into ISO values. Each line may carry
// a comma-separated list, and the property may repeat (RFC 5545 §3.8.5.1).
//
// A TZID-qualified date-time (`EXDATE;TZID=Europe/Berlin:20260623T120000`, the
// form foreign clients write) is resolved to a UTC ISO instant, like
// parseRecurrenceInstant does: left floating, `Date.parse` would read it as the
// host's local time and it would never compare equal to an occurrence's
// instant. UTC (`…Z`) and DATE values are surfaced as stored.
const parseExcludedDates = (exdates: ParsedProperty[]): string[] =>
  exdates.flatMap((property) => {
    const timeZone = propertyTimeZone(property)
    return property.value
      .split(',')
      .map((value) => resolveExcludedValue(icalDateToIso(value.trim()), timeZone))
      .filter(Boolean)
  })

const resolveExcludedValue = (iso: string, timeZone: string | undefined): string => {
  if (!(timeZone && iso.includes('T')) || iso.endsWith('Z')) {
    return iso
  }
  try {
    return new Date(parseWallClockInZone(iso, timeZone).getTime()).toISOString()
  } catch {
    return iso
  }
}

// A DATE (not DATE-TIME) property value: `;VALUE=DATE`, or a bare 8-digit value
// from a producer that omits the (technically required) parameter.
const VALUE_DATE_RE = /(?:^|;)VALUE=DATE(?:;|$)/iu
const DATE_ONLY_VALUE_RE = /^\d{8}$/u
// TRANSP value → showAs, case-insensitively. Anything else reads as unset.
const SHOW_AS: Record<string, ShowAs> = { OPAQUE: 'busy', TRANSPARENT: 'free' }
const parseShowAs = (property: ParsedProperty | undefined): ShowAs | undefined =>
  property ? SHOW_AS[property.value.trim().toUpperCase()] : undefined

const isDateValue = (property: ParsedProperty | undefined): boolean =>
  property !== undefined && (VALUE_DATE_RE.test(property.params) || DATE_ONLY_VALUE_RE.test(property.value.trim()))

// Parses every VEVENT in a VCALENDAR. Blocks without a UID are skipped —
// an event we can't address with update/delete isn't useful to list.
// The fields a VEVENT only carries sometimes. Split out from parseEvents so the
// conditional-spread block doesn't dominate that function's complexity.
const optionalFields = (block: ParsedBlock, attendees: ParsedAttendee[]): Partial<ParsedEvent> => {
  const description = block.props.get('DESCRIPTION')?.value
  const location = block.props.get('LOCATION')?.value
  const organizer = parseOrganizerEmail(block.props.get('ORGANIZER'))
  // Trim so a server that emits a trailing space (`RRULE:FREQ=WEEKLY `) doesn't
  // leak it into the listed `repeats:` value.
  const recurrence = block.props.get('RRULE')?.value.trim()
  const recurrenceId = parseRecurrenceInstant(block.props.get('RECURRENCE-ID'))
  const excludedDates = parseExcludedDates(block.exdates)
  const unparsedAttendeeCount = block.attendees.length - attendees.length
  const allDay = isDateValue(block.props.get('DTSTART'))
  // A TZID beside a DATE is off-spec and meaningless; surfacing it would let
  // consumers re-express a date-only series in that zone.
  const startTzid = allDay ? undefined : propertyTimeZone(block.props.get('DTSTART'))
  const showAs = parseShowAs(block.props.get('TRANSP'))
  const status = block.props.get('STATUS')?.value.trim().toUpperCase()
  const classification = block.props.get('CLASS')?.value.trim().toUpperCase()
  const duration = block.props.get('DURATION')?.value.trim()
  return {
    ...(block.alarms.length > 0 ? { alarms: block.alarms.map(parseAlarm) } : {}),
    ...(allDay ? { allDay: true as const } : {}),
    ...(classification ? { classification } : {}),
    ...(description ? { description: unescapeText(description) } : {}),
    ...(duration ? { duration } : {}),
    ...(excludedDates.length > 0 ? { excludedDates } : {}),
    ...(location ? { location: unescapeText(location) } : {}),
    ...(organizer ? { organizer } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(recurrenceId ? { recurrenceId } : {}),
    ...(showAs ? { showAs } : {}),
    ...(startTzid ? { startTzid } : {}),
    ...(status ? { status } : {}),
    ...(unparsedAttendeeCount > 0 ? { unparsedAttendeeCount } : {}),
  }
}

export const parseEvents = (ical: string): ParsedEvent[] => {
  const events: ParsedEvent[] = []
  for (const block of eventBlocks(ical)) {
    const uid = block.props.get('UID')
    if (!uid?.value) {
      continue
    }
    const attendees = block.attendees.map(parseAttendee).filter((a): a is ParsedAttendee => a !== undefined)
    events.push({
      attendees,
      end: icalDateToIso(block.props.get('DTEND')?.value ?? ''),
      start: icalDateToIso(block.props.get('DTSTART')?.value ?? ''),
      title: unescapeText(block.props.get('SUMMARY')?.value ?? ''),
      uid: uid.value,
      ...optionalFields(block, attendees),
    })
  }
  return events
}
