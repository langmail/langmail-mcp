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
  | { kind: 'alreadyThere' }
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

// With URLs, so the next call can pass fromCalendar even when two calendars share a name.
const namesWithUrls = (calendars: CalendarSummary[]): string =>
  calendars.map((c) => `"${calendarLabel(c)}" <${c.url}>`).join(' and ')

// A uid in both the destination and a source is two stored events, not one.
// delete_calendar_event looks in one calendar only (the default one unless
// given calendarUrl), so the remedy names both URLs and the argument.
const duplicateRemedy = (dest: CalendarSummary, others: CalendarSummary[]): string =>
  `"${calendarLabel(dest)}" <${dest.url}> already holds a separate copy of this event, and ` +
  `${namesWithUrls(others)} still ${others.length > 1 ? 'hold' : 'holds'} one; ask the user which copy to keep ` +
  'and delete the other with delete_calendar_event, passing its calendar URL as calendarUrl'

const refusalReason = (
  outcome: Exclude<MoveEventOutcome, { kind: 'moved' }>,
  source: CalendarSummary,
  dest: CalendarSummary
): string => {
  switch (outcome.kind) {
    case 'uidConflict':
      return `uidConflict: ${duplicateRemedy(dest, [source])}`
    case 'nameConflict':
      return `nameConflict: "${calendarLabel(dest)}" already has an event stored under the same name; this cannot be resolved with these tools`
    case 'forbidden':
      return 'forbidden: this account may not move events between these calendars'
    default:
      return `failed: the server answered HTTP ${outcome.status}; re-run to retry`
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
    return outcome.kind === 'moved'
      ? outcome
      : { kind: 'notMoved', reason: refusalReason(outcome, source.calendar, dest) }
  } catch {
    // davRequest never throws on an HTTP status, only when the exchange broke
    // off (a timeout, a dropped connection) — possibly after Stalwart had
    // already committed the move. So the outcome is unknown, never "not moved".
    return { kind: 'indeterminate' }
  }
}

const formatResult = (
  dest: CalendarSummary,
  outcomes: [string, Outcome][],
  unreadable: CalendarSummary[]
): ToolResult => {
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
    lines.push(`Already in ${name} (${already.length}): ${already.map(([uid]) => uid).join(', ')}.`)
  }
  if (notMoved.length > 0) {
    lines.push(`Not moved (${notMoved.length}): ${notMoved.map(([uid, o]) => `${uid} (${o.reason})`).join(', ')}.`)
  }
  if (indeterminate.length > 0) {
    lines.push(
      `Outcome unknown (${indeterminate.length}): ${indeterminate.map(([uid]) => uid).join(', ')} — the connection ` +
        'broke off before the server answered, so they may have moved. Re-run with these uids to find out.'
    )
  }
  if (notAttempted.length > 0) {
    lines.push(
      `Not attempted (${notAttempted.length}): ${notAttempted.map(([uid]) => uid).join(', ')} — out of time. ` +
        'Re-run with these uids.'
    )
  }
  if (unreadable.length > 0) {
    lines.push(
      `Could not read ${quotedNames(unreadable)}, so events there were not found; re-run later, or pass ` +
        'fromCalendar to look in one calendar only.'
    )
  }
  const text = lines.join('\n')
  // A partial batch is a normal result; only a call that certainly achieved
  // nothing is an error — an unknown outcome may have been a move.
  return moved.length + already.length + indeterminate.length === 0 ? errorResult(text) : textResult(text)
}

type Step<T> = { ok: true; value: T } | { error: ToolResult; ok: false }

// The calendars to look in: only fromCalendar when given, else every calendar
// but the destination. fetchCalendarList reads the principal's own calendar
// home only, so every source and destination belongs to this account — the
// case the silent, copy-free MOVE is verified for.
const resolveSources = (
  calendars: CalendarSummary[],
  dest: CalendarSummary,
  fromCalendar: string | undefined
): Step<{ from?: CalendarSummary; sources: CalendarSummary[] }> => {
  if (fromCalendar === undefined) {
    return { ok: true, value: { sources: calendars.filter((c) => !sameCalendarUrl(c.url, dest.url)) } }
  }
  const resolved = resolveCalendar(calendars, fromCalendar, { argName: 'fromCalendar', nothingDone: NOTHING_MOVED })
  if (!resolved.ok) {
    return resolved
  }
  if (sameCalendarUrl(resolved.calendar.url, dest.url)) {
    return {
      error: errorResult(
        `fromCalendar and calendar both name "${calendarLabel(dest)}". ${NOTHING_MOVED} ` +
          'Pass the calendar the events are in now as fromCalendar, or omit it.'
      ),
      ok: false,
    }
  }
  return { ok: true, value: { from: resolved.calendar, sources: [resolved.calendar] } }
}

interface Listed {
  inDest: Set<string>
  index: Map<string, Location[]>
  unreadable: CalendarSummary[]
}

// Lists every calendar involved once, in parallel. The destination is always
// listed: an event already there is a success, which makes a repeated call a
// no-op. Without it nothing can be decided, but one unreadable source must
// not block moves out of the others.
const listCalendarsInvolved = async (
  deps: MoveCalendarEventsDeps,
  token: string,
  dest: CalendarSummary,
  sources: CalendarSummary[]
): Promise<Step<Listed>> => {
  const [destListing, ...sourceResults] = await Promise.allSettled(
    [dest, ...sources].map((calendar) => deps.listEvents(token, calendar.url))
  )
  if (destListing?.status !== 'fulfilled') {
    const reason = destListing?.reason instanceof Error ? destListing.reason.message : String(destListing?.reason)
    return {
      error: errorResult(`Could not read "${calendarLabel(dest)}": ${reason}. ${NOTHING_MOVED} Re-run later.`),
      ok: false,
    }
  }
  const readable = sources.flatMap((calendar, i) => {
    const r = sourceResults[i]
    return r?.status === 'fulfilled' ? [{ calendar, objects: r.value }] : []
  })
  return {
    ok: true,
    value: {
      inDest: new Set(destListing.value.flatMap(uidsOf)),
      index: indexByUid(readable),
      unreadable: sources.filter((_, i) => sourceResults[i]?.status !== 'fulfilled'),
    },
  }
}

// The outcome decided without touching the server, or the one location to
// move from. The first rule that applies wins, in this order.
const decide = (
  uid: string,
  listed: Listed,
  dest: CalendarSummary,
  from: CalendarSummary | undefined
): Outcome | Location => {
  const locations = listed.index.get(uid) ?? []
  if (listed.inDest.has(uid)) {
    // Only a uid that has left every source is done; one still in a source
    // is a duplicate, and calling it done would leave that copy behind.
    return locations.length === 0
      ? { kind: 'alreadyThere' }
      : {
          kind: 'notMoved',
          reason: `duplicate: ${duplicateRemedy(
            dest,
            locations.map((l) => l.calendar)
          )}`,
        }
  }
  const [only] = locations
  if (!only) {
    const where = from ? `not in "${calendarLabel(from)}"` : 'in none of your calendars'
    return { kind: 'notMoved', reason: `notFound: ${where}; check the uid with list_calendar_events` }
  }
  if (locations.length > 1) {
    const reason = `ambiguous: in ${namesWithUrls(locations.map((l) => l.calendar))}; pass one as fromCalendar`
    return { kind: 'notMoved', reason }
  }
  return only
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
  const sources = resolveSources(calendars, dest, args.fromCalendar)
  if (!sources.ok) {
    return sources.error
  }
  const listed = await listCalendarsInvolved(deps, token, dest, sources.value.sources)
  if (!listed.ok) {
    return listed.error
  }

  const outcomes: [string, Outcome][] = []
  for (const uid of args.uids) {
    const decided = decide(uid, listed.value, dest, sources.value.from)
    if ('kind' in decided) {
      outcomes.push([uid, decided])
    } else if (deps.now() - started >= MOVE_BUDGET_MS) {
      outcomes.push([uid, { kind: 'notAttempted' }])
    } else {
      outcomes.push([uid, await moveOne(deps, token, decided, dest)])
    }
  }

  return formatResult(dest, outcomes, listed.value.unreadable)
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
