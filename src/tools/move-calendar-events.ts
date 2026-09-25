// move_calendar_events tool — re-files events on another of the principal's
// calendars with one WebDAV MOVE per event (docs: caldav/client.ts moveEvent).
//
// A copy-and-delete would flatten changed occurrences, drop every property
// the tools never read (alarms, attachments, TRANSP…) and give the event a
// new UID, which re-invites every attendee. Stalwart's MOVE re-parents the
// stored event instead, so none of that happens and no iMIP leaves the
// server — which is why this is ACCOUNT_WRITE while update_calendar_event is
// OUTWARD_DESTRUCTIVE. If a MOVE is refused, nothing falls back to a copy.
//
// Each calendar involved is listed once, in parallel, into a UID → location
// index; the moves then run one at a time so the per-event outcomes come
// back in a deterministic order. Like the other CalDAV tools, the logic sits
// behind a `Deps` interface so it unit-tests without live Stalwart.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { parseEvents } from '@langmail/ical'

import {
  type CalDavConfig,
  fetchCalendarList,
  fetchEvents,
  isTimeoutError,
  type MoveEventOutcome,
  type MoveEventParams,
  moveEvent,
  withTrailingSlash,
} from '../caldav/client.ts'
import { type CalendarObject, type CalendarSummary } from '../caldav/types.ts'
import { ACCOUNT_WRITE } from './annotations.ts'
import { calendarLabel, resolveCalendar, sameCalendarUrl } from './calendar-lookup.ts'
import { eventUidSchema } from './create-calendar-event.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const MAX_MOVE_UIDS = 50

// CALDAV_TIMEOUT_MS bounds each request, not the call. No new MOVE starts
// once this much time has passed since the call began; the rest are reported
// as not attempted, and a re-run picks them up.
export const MOVE_BUDGET_MS = 45_000

const NOTHING_MOVED = 'Nothing was moved.'

const moveCalendarEventsShape = {
  calendar: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Destination calendar: its name (matched ignoring case) or its URL, both as list_calendars ' +
        'shows them. It must already exist; calendars are never created here.'
    ),
  fromCalendar: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Only needed when a uid exists in more than one calendar: the calendar to move it out of, ' +
        'by name or URL. Omit otherwise; each event is found wherever it is.'
    ),
  uids: z
    .array(eventUidSchema)
    .min(1)
    .max(MAX_MOVE_UIDS)
    .describe(
      'Events to move, by the uid list_calendar_events shows. A recurring event moves as a whole ' +
        `series, including its changed occurrences. Up to ${MAX_MOVE_UIDS} per call.`
    ),
}

// Duplicates are collapsed so one event is never reported twice (overrides of
// a series share its uid in list_calendar_events). The cap applies to the
// uids as given, before collapsing.
export const moveCalendarEventsInput = z.object({
  ...moveCalendarEventsShape,
  uids: moveCalendarEventsShape.uids.transform((uids) => [...new Set(uids)]),
})

export type MoveCalendarEventsArgs = z.infer<typeof moveCalendarEventsInput>

export interface MoveCalendarEventsDeps {
  listCalendars: (token: string) => Promise<CalendarSummary[]>
  listEvents: (token: string, calendarUrl: string) => Promise<CalendarObject[]>
  moveEvent: (params: MoveEventParams) => Promise<MoveEventOutcome>
  // Milliseconds; injected so the time budget unit-tests.
  now: () => number
}

export interface MoveCalendarEventsContext {
  args: MoveCalendarEventsArgs
  token: string
}

interface Location {
  calendar: CalendarSummary
  object: CalendarObject
}

type Outcome =
  | { kind: 'moved' }
  | { alsoIn: CalendarSummary[]; kind: 'alreadyThere' }
  | { kind: 'notMoved'; reason: string }
  | { kind: 'indeterminate' }
  | { kind: 'notAttempted' }

// Every uid a stored object carries, once — a series and its overrides are
// one object with one uid.
const uidsOf = (object: CalendarObject): string[] => [...new Set(parseEvents(object.data).map((e) => e.uid))]

const indexByUid = (listings: { calendar: CalendarSummary; objects: CalendarObject[] }[]): Map<string, Location[]> => {
  const index = new Map<string, Location[]>()
  for (const { calendar, objects } of listings) {
    for (const object of objects) {
      for (const uid of uidsOf(object)) {
        index.set(uid, [...(index.get(uid) ?? []), { calendar, object }])
      }
    }
  }
  return index
}

// The last path segment, copied verbatim from the href the listing returned.
// Never decoded or re-encoded: Stalwart treats `@` and `%40` in a resource
// name as two different resources, so a normalized spelling can move a
// different event (docs/upstream/stalwart/caldav-resource-name-encoding-asymmetric.md).
const resourceName = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

const quotedNames = (calendars: CalendarSummary[]): string =>
  calendars.map((c) => `"${calendarLabel(c)}"`).join(' and ')

const refusalReason = (outcome: Exclude<MoveEventOutcome, { kind: 'moved' }>, dest: CalendarSummary): string => {
  switch (outcome.kind) {
    case 'uidConflict':
      return `uidConflict: "${calendarLabel(dest)}" already holds another event with this uid`
    case 'nameConflict':
      return `nameConflict: "${calendarLabel(dest)}" already has an event stored under the same name`
    case 'forbidden':
      return 'forbidden: this account may not move events between these calendars'
    default:
      return `failed: the server answered HTTP ${outcome.status}`
  }
}

const moveOne = async (
  deps: MoveCalendarEventsDeps,
  token: string,
  source: Location,
  dest: CalendarSummary
): Promise<Outcome> => {
  try {
    const outcome = await deps.moveEvent({
      destination: `${withTrailingSlash(dest.url)}${resourceName(source.object.url)}`,
      token,
      url: source.object.url,
    })
    return outcome.kind === 'moved' ? outcome : { kind: 'notMoved', reason: refusalReason(outcome, dest) }
  } catch (err) {
    if (isTimeoutError(err)) {
      return { kind: 'indeterminate' }
    }
    const reason = err instanceof Error ? err.message : String(err)
    return { kind: 'notMoved', reason: `failed: ${reason}` }
  }
}

const formatResult = (dest: CalendarSummary, outcomes: [string, Outcome][]): ToolResult => {
  const name = calendarLabel(dest)
  const of = <K extends Outcome['kind']>(kind: K) =>
    outcomes.filter((o): o is [string, Extract<Outcome, { kind: K }>] => o[1].kind === kind)
  const moved = of('moved')
  const already = of('alreadyThere')
  const notMoved = of('notMoved')
  const indeterminate = of('indeterminate')
  const notAttempted = of('notAttempted')

  const lines = [`Moved ${moved.length} event(s) to ${name}.`]
  if (already.length > 0) {
    const items = already.map(([uid, o]) =>
      o.alsoIn.length > 0 ? `${uid} (a copy with this uid is also in ${quotedNames(o.alsoIn)})` : uid
    )
    lines.push(`Already in ${name} (${already.length}): ${items.join(', ')}.`)
  }
  if (notMoved.length > 0) {
    lines.push(`Not moved (${notMoved.length}): ${notMoved.map(([uid, o]) => `${uid} (${o.reason})`).join(', ')}.`)
  }
  if (indeterminate.length > 0) {
    lines.push(
      `Outcome unknown (${indeterminate.length}): ${indeterminate.map(([uid]) => uid).join(', ')} — the server did ` +
        'not answer in time and may have moved them. Re-run with these uids to find out.'
    )
  }
  if (notAttempted.length > 0) {
    lines.push(
      `Not attempted (${notAttempted.length}): ${notAttempted.map(([uid]) => uid).join(', ')} — out of time. ` +
        'Re-run with these uids.'
    )
  }
  const text = lines.join('\n')
  // A partial batch is a normal result; only a call that achieved nothing is an error.
  return moved.length + already.length === 0 ? errorResult(text) : textResult(text)
}

export const moveCalendarEvents = async (
  deps: MoveCalendarEventsDeps,
  ctx: MoveCalendarEventsContext
): Promise<ToolResult> => {
  const { args, token } = ctx
  const started = deps.now()

  const calendars = await deps.listCalendars(token)
  const destResolved = resolveCalendar(calendars, args.calendar, { argName: 'calendar', nothingDone: NOTHING_MOVED })
  if (!destResolved.ok) {
    return destResolved.error
  }
  const dest = destResolved.calendar

  let from: CalendarSummary | undefined
  if (args.fromCalendar !== undefined) {
    const fromResolved = resolveCalendar(calendars, args.fromCalendar, {
      argName: 'fromCalendar',
      nothingDone: NOTHING_MOVED,
    })
    if (!fromResolved.ok) {
      return fromResolved.error
    }
    if (sameCalendarUrl(fromResolved.calendar.url, dest.url)) {
      return errorResult(
        `fromCalendar and calendar both name "${calendarLabel(dest)}". ${NOTHING_MOVED} ` +
          'Pass the calendar the events are in now as fromCalendar, or omit it.'
      )
    }
    from = fromResolved.calendar
  }
  const sources = from ? [from] : calendars.filter((c) => !sameCalendarUrl(c.url, dest.url))

  // The destination is always listed: an event already there is a success,
  // which makes a repeated call a no-op.
  const listings = await Promise.all(
    [dest, ...sources].map(async (calendar) => ({ calendar, objects: await deps.listEvents(token, calendar.url) }))
  )
  const [destListing, ...sourceListings] = listings
  const inDest = new Set(destListing?.objects.flatMap(uidsOf))
  const index = indexByUid(sourceListings)

  const outcomes: [string, Outcome][] = []
  for (const uid of args.uids) {
    const locations = index.get(uid) ?? []
    if (inDest.has(uid)) {
      outcomes.push([uid, { alsoIn: locations.map((l) => l.calendar), kind: 'alreadyThere' }])
      continue
    }
    const [only] = locations
    if (!only) {
      const where = from ? `not in "${calendarLabel(from)}"` : 'in none of your calendars'
      outcomes.push([uid, { kind: 'notMoved', reason: `notFound: ${where}` }])
      continue
    }
    if (locations.length > 1) {
      const reason = `ambiguous: in ${quotedNames(locations.map((l) => l.calendar))}; pass fromCalendar`
      outcomes.push([uid, { kind: 'notMoved', reason }])
      continue
    }
    if (deps.now() - started >= MOVE_BUDGET_MS) {
      outcomes.push([uid, { kind: 'notAttempted' }])
      continue
    }
    outcomes.push([uid, await moveOne(deps, token, only, dest)])
  }

  return formatResult(dest, outcomes)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): MoveCalendarEventsDeps => ({
  listCalendars: (token) => fetchCalendarList(cfg, token),
  listEvents: (token, calendarUrl) => fetchEvents(cfg, { calendarUrl, token }),
  moveEvent: (params) => moveEvent(cfg, params),
  now: () => Date.now(),
})

// --- MCP registration ----------------------------------------------------

export const registerMoveCalendarEvents = (
  server: McpServer,
  deps: MoveCalendarEventsDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'move_calendar_events',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Moves events from one of the user’s calendars to another — for example into a new "Private" ' +
        'calendar — without changing their time or content. Use this when the user wants events filed ' +
        'on a different calendar; to change when an event happens (“move the meeting to 3 pm”), use ' +
        'update_calendar_event instead. Events keep their uid, attendees, reminders and every ' +
        'occurrence of a recurring series, and attendees are not notified. Returns how many events ' +
        'moved and names each one that did not, with the reason; the destination calendar must ' +
        'already exist (create one with create_calendar). Safe to re-run.',
      inputSchema: moveCalendarEventsShape,
      title: 'Move calendar events',
    },
    (args) => moveCalendarEvents(deps, { args: moveCalendarEventsInput.parse(args), token: getToken() })
  )
}
