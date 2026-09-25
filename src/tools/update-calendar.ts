// update_calendar tool — renames and/or recolors one of the principal's
// calendars with a CalDAV PROPPATCH of `displayname` and `calendar-color`.
//
// The calendar is picked by its current name or its URL, so an agent that
// skipped list_calendars still lands on the right one — and when it does not,
// the error lists every calendar with its URL so the next call can succeed
// without a separate lookup.
//
// Like the other CalDAV tools, the logic sits behind a `Deps` interface so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  type CalDavConfig,
  fetchCalendarList,
  type UpdateCalendarParams,
  updateCalendar as updateCalendarCollection,
  withTrailingSlash,
} from '../caldav/client.ts'
import { type CalendarSummary } from '../caldav/types.ts'
import { ACCOUNT_WRITE } from './annotations.ts'
import { colorSchema } from './create-calendar.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// A URL or a server-absolute path ("/dav/cal/…"), as opposed to a name.
const URL_OR_PATH_RE = /^(?:https?:\/\/|\/)/iu

const updateCalendarShape = {
  calendar: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The calendar to change: its current name (matched ignoring case) or its URL, both as ' +
        'list_calendars shows them. Use the URL when two calendars share a name.'
    ),
  color: colorSchema.optional().describe('New color as a hex value, e.g. "#2E6FD8". Omit to keep the current color.'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('New name; must differ from every other calendar’s name. Omit to keep the current name.'),
}

export const updateCalendarInput = z.object(updateCalendarShape)

export type UpdateCalendarArgs = z.infer<typeof updateCalendarInput>

export interface UpdateCalendarDeps {
  listCalendars: (token: string) => Promise<CalendarSummary[]>
  updateCalendar: (params: UpdateCalendarParams) => Promise<void>
}

export interface UpdateCalendarContext {
  args: UpdateCalendarArgs
  token: string
}

const normalizeName = (name: string): string => name.trim().toLowerCase()

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

const label = (cal: CalendarSummary): string => cal.displayName || '(unnamed)'

const calendarLines = (calendars: CalendarSummary[]): string =>
  calendars.map((c, i) => `${i + 1}. ${label(c)} — ${c.url}`).join('\n')

type Resolved = { calendar: CalendarSummary; ok: true } | { error: ToolResult; ok: false }

// Strict resolution: an exact URL (modulo trailing slash) or an exact name
// (modulo case and outer spaces). No fuzzy matching — a miss lists every
// calendar instead, which beats a guess when a person has a handful of them.
const resolveCalendar = (calendars: CalendarSummary[], ref: string): Resolved => {
  const isUrl = URL_OR_PATH_RE.test(ref)
  // An unparseable reference has no key, so it matches nothing and the miss below lists the calendars.
  const refKey = isUrl ? urlKey(ref) : null
  const matches = isUrl
    ? calendars.filter((c) => refKey !== null && urlKey(c.url) === refKey)
    : calendars.filter((c) => normalizeName(c.displayName) === normalizeName(ref))

  const [only] = matches
  if (only && matches.length === 1) {
    return { calendar: only, ok: true }
  }
  if (matches.length > 1) {
    return {
      error: errorResult(
        `${matches.length} calendars are named "${ref}". Nothing was changed. ` +
          `Pass the URL of the one you mean as calendar:\n${calendarLines(matches)}`
      ),
      ok: false,
    }
  }
  const miss = isUrl ? `No calendar at ${ref}.` : `No calendar named "${ref}".`
  const available =
    calendars.length === 0
      ? 'This account has no calendars; use create_calendar to make one.'
      : `Your calendars:\n${calendarLines(calendars)}\nPass one of these names or URLs as calendar.`
  return { error: errorResult(`${miss} Nothing was changed. ${available}`), ok: false }
}

const describeChanges = (args: UpdateCalendarArgs): string =>
  [
    ...(args.name === undefined ? [] : [`name → "${args.name}"`]),
    ...(args.color === undefined ? [] : [`color → ${args.color}`]),
  ].join(', ')

export const updateCalendar = async (deps: UpdateCalendarDeps, ctx: UpdateCalendarContext): Promise<ToolResult> => {
  const { args, token } = ctx
  if (args.name === undefined && args.color === undefined) {
    return errorResult('Nothing to change. Pass name, color, or both.')
  }

  const calendars = await deps.listCalendars(token)
  const resolved = resolveCalendar(calendars, args.calendar)
  if (!resolved.ok) {
    return resolved.error
  }
  const target = resolved.calendar

  // A duplicate name would make every later lookup by that name ambiguous.
  if (args.name !== undefined) {
    const newName = args.name
    const taken = calendars.find((c) => c.url !== target.url && normalizeName(c.displayName) === normalizeName(newName))
    if (taken) {
      return errorResult(
        `Another calendar is already named "${taken.displayName}" (${taken.url}). Nothing was changed. ` +
          'Pick a different name, or rename that calendar first with update_calendar.'
      )
    }
  }

  try {
    await deps.updateCalendar({ color: args.color, name: args.name, token, url: target.url })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // PROPPATCH is all-or-nothing (RFC 4918 §9.2), so a refusal changed nothing.
    return errorResult(
      `Could not update calendar "${label(target)}": ${reason}. Nothing was changed. ` +
        'The calendar may be read-only for this account; check it with list_calendars.'
    )
  }

  return textResult(`Calendar "${label(target)}" updated: ${describeChanges(args)}.\ncalendarUrl: ${target.url}`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): UpdateCalendarDeps => ({
  listCalendars: (token) => fetchCalendarList(cfg, token),
  updateCalendar: (params) => updateCalendarCollection(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerUpdateCalendar = (
  server: McpServer,
  deps: UpdateCalendarDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'update_calendar',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Renames or recolors one of the user’s calendars — the calendar itself, not an event on it. ' +
        'Use this when the user wants to rename a calendar or change its color; name the calendar by ' +
        'its current name or its URL from list_calendars. Returns the changes made and the calendar’s ' +
        'URL; when no calendar matches, the error lists every calendar with its URL, and nothing is ' +
        'changed. To change an event, use update_calendar_event; to add a new calendar, use ' +
        'create_calendar. Safe to re-run.',
      inputSchema: updateCalendarShape,
      title: 'Update calendar',
    },
    (args) => {
      const parsed = updateCalendarInput.parse(args)
      return updateCalendar(deps, { args: parsed, token: getToken() })
    }
  )
}
