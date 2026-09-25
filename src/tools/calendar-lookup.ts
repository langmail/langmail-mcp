// Name-or-URL resolution for the tools that take a `calendar` argument
// (update_calendar, move_calendar_events). An agent that skipped
// list_calendars still lands on the right calendar — and when it does not,
// the error lists every calendar with its URL so the next call can succeed
// without a separate lookup.

import { withTrailingSlash } from '../caldav/client.ts'
import { type CalendarSummary } from '../caldav/types.ts'
import { errorResult, type ToolResult } from './result.ts'

// A URL or a server-absolute path ("/dav/cal/…"), as opposed to a name.
const URL_OR_PATH_RE = /^(?:https?:\/\/|\/)/iu

export const normalizeCalendarName = (name: string): string => name.trim().toLowerCase()

// Every calendar sits on the one CalDAV server, so the decoded path alone
// identifies it: an agent that decodes %40 to @, swaps the scheme, or
// changes host case still lands on the same calendar.
const urlKey = (url: string): string | null => {
  try {
    const { pathname } = new URL(url, 'https://calendar.invalid')
    return withTrailingSlash(decodeURIComponent(pathname))
  } catch {
    // An unparseable URL or a malformed %-escape matches nothing; the miss
    // error then lists the calendars.
    return null
  }
}

// Whether two calendar URLs name the same collection (see urlKey).
export const sameCalendarUrl = (a: string, b: string): boolean => {
  const key = urlKey(a)
  return key !== null && key === urlKey(b)
}

export const calendarLabel = (cal: CalendarSummary): string => cal.displayName || '(unnamed)'

const calendarLines = (calendars: CalendarSummary[]): string =>
  calendars.map((c, i) => `${i + 1}. ${calendarLabel(c)} — ${c.url}`).join('\n')

export interface ResolveCalendarWording {
  // The tool argument the reference came from, named in "pass … as <argName>".
  argName: string
  // The refusal sentence, e.g. "Nothing was changed."
  nothingDone: string
}

export type ResolvedCalendar = { calendar: CalendarSummary; ok: true } | { error: ToolResult; ok: false }

// Strict resolution: an exact URL (modulo trailing slash) or an exact name
// (modulo case and outer spaces). No fuzzy matching — a miss lists every
// calendar instead, which beats a guess when a person has a handful of them.
export const resolveCalendar = (
  calendars: CalendarSummary[],
  ref: string,
  wording: ResolveCalendarWording
): ResolvedCalendar => {
  const { argName, nothingDone } = wording
  const isUrl = URL_OR_PATH_RE.test(ref)
  const matches = isUrl
    ? calendars.filter((c) => sameCalendarUrl(c.url, ref))
    : calendars.filter((c) => normalizeCalendarName(c.displayName) === normalizeCalendarName(ref))

  const [only] = matches
  if (only && matches.length === 1) {
    return { calendar: only, ok: true }
  }
  if (matches.length > 1) {
    return {
      error: errorResult(
        `${matches.length} calendars are named "${ref}". ${nothingDone} ` +
          `Pass the URL of the one you mean as ${argName}:\n${calendarLines(matches)}`
      ),
      ok: false,
    }
  }
  const miss = isUrl ? `No calendar at ${ref}.` : `No calendar named "${ref}".`
  const available =
    calendars.length === 0
      ? 'This account has no calendars; use create_calendar to make one.'
      : `Your calendars:\n${calendarLines(calendars)}\nPass one of these names or URLs as ${argName}.`
  return { error: errorResult(`${miss} ${nothingDone} ${available}`), ok: false }
}
