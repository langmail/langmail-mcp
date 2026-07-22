// update_calendar_event tool — replaces an existing VEVENT in place and
// re-sends DKIM-signed iMIP invitations with a bumped SEQUENCE, so the
// attendees' clients treat it as an update rather than a new invite.
//
// The edit is a full re-specification of the event (title/time/attendees),
// addressed by the stable UID returned from create_calendar_event. We fetch
// the current object to confirm it exists, read its SEQUENCE, and PUT the
// rebuilt iCal back to the same URL with the original ETag.
//
// Two edit modes, chosen by `recurrenceId`:
//   - omitted → the whole event (the entire series for a recurring one), exactly
//     as before;
//   - present → a single occurrence of a recurring series, written as a
//     RECURRENCE-ID override spliced alongside the untouched master (see
//     caldav/occurrence.ts). Stalwart then schedules an iMIP update scoped to
//     that instance.
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + updateEvent)
// so it unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type AccountTimeZoneResolver, makeAccountTimeZoneResolver } from '../caldav/account-settings.ts'
import {
  type CalDavConfig,
  discoverAccount,
  type FetchEventParams,
  fetchEvent,
  resolveCalendarUrl,
  type UpdateEventParams,
  updateEvent,
} from '../caldav/client.ts'
import { buildInvite, maxSequence, parseSequence } from '../caldav/ical.ts'
import { type ParsedEvent, parseEvents } from '../caldav/ical-parse.ts'
import { spliceOccurrenceOverride } from '../caldav/occurrence.ts'
import { isSeriesOccurrence, toRRule } from '../caldav/recurrence.ts'
import { resolveInputDateTime, UTC_TIME_ZONE } from '../caldav/timezone.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { createCalendarEventInput, eventUidSchema } from './create-calendar-event.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const recurrenceIdDescription =
  'Optional ISO 8601 instant that scopes this edit to a single occurrence of a ' +
  'recurring series, identified by that occurrence’s original start (e.g. ' +
  '2026-06-16T10:00:00Z). When set, only that occurrence changes — the master ' +
  'rule and every other occurrence stay exactly as they are — and start/end ' +
  'become the occurrence’s new time (pass the same instant here and in start to ' +
  'keep the time and change only other fields). The instant must land on an ' +
  'actual occurrence of the series. Omit to edit the whole event. Cannot be ' +
  'combined with `recurrence` or with `addedAttendees`/`removedAttendees`.'

const attendeesDescription =
  'The complete attendee list (full replacement) — every address that should be ' +
  'invited after the edit. Required unless you pass `addedAttendees`/`removedAttendees`, ' +
  'which change specific attendees against the stored list instead. Cannot be combined ' +
  'with those delta fields.'

const addedAttendeesDescription =
  'Email addresses to add to the event’s current attendee list, merged on top of ' +
  'the stored attendees — you do NOT re-supply the existing ones. Adding an address ' +
  'already invited is a no-op. Cannot be combined with `attendees` (the full-replacement ' +
  'list). When you pass this or `removedAttendees`, every other field you omit ' +
  '(start, end, title, recurrence, location, description) is kept as stored, so a ' +
  'recurring series stays recurring.'

const removedAttendeesDescription =
  'Email addresses to remove from the event’s current attendee list, applied against ' +
  'the stored attendees (matched case-insensitively). Removing an address that isn’t ' +
  'invited is a no-op. This is the safe way to drop one attendee from a recurring ' +
  'meeting: you name only the address to remove and re-supply nothing else. Cannot be ' +
  'combined with `attendees`.'

const notifyDescription =
  'Who to notify by iMIP. `all` (default) re-sends invitations/updates to the ' +
  'attendees, as a normal edit does. `none` makes the edit silent — the attendees on ' +
  'the event are not notified — for a trivial change (e.g. dropping your own duplicate ' +
  'address) that shouldn’t disturb everyone. A removed attendee may still receive a ' +
  'cancellation.'

const optionalWhenDelta = (verb: string): string =>
  ` Optional when using an attendee delta (addedAttendees/removedAttendees): omit to ${verb}. Required otherwise.`

const shared = createCalendarEventInput.shape

export const updateCalendarEventInput = z.object({
  addedAttendees: z.array(z.email()).min(1).max(50).optional().describe(addedAttendeesDescription),
  attendees: shared.attendees.optional().describe(attendeesDescription),
  calendarUrl: shared.calendarUrl,
  description: shared.description,
  end: shared.end.optional().describe(`Event end as ISO 8601.${optionalWhenDelta('keep the stored end')}`),
  location: shared.location,
  notify: z.enum(['all', 'none']).optional().describe(notifyDescription),
  recurrence: shared.recurrence,
  recurrenceId: z.iso.datetime({ offset: true }).optional().describe(recurrenceIdDescription),
  removedAttendees: z.array(z.email()).min(1).max(50).optional().describe(removedAttendeesDescription),
  start: shared.start.optional().describe(`Event start as ISO 8601.${optionalWhenDelta('keep the stored start')}`),
  timeZone: shared.timeZone,
  title: shared.title.optional().describe(`Event title.${optionalWhenDelta('keep the stored title')}`),
  uid: eventUidSchema,
})

export type UpdateCalendarEventArgs = z.infer<typeof updateCalendarEventInput>

// Merges an attendee delta onto the stored list: start from `base`, append
// `added`, drop everything in `removed`. All comparison is case-insensitive
// (RFC 5545 calendar-user-addresses are), and duplicates collapse to the first
// spelling seen — so re-adding an existing attendee or removing an absent one is
// a harmless no-op, and the result never carries the same address twice.
export const mergeAttendees = (base: string[], added: string[], removed: string[]): string[] => {
  const removedSet = new Set(removed.map((email) => email.toLowerCase()))
  const seen = new Set<string>()
  const result: string[] = []
  for (const email of [...base, ...added]) {
    const key = email.toLowerCase()
    if (removedSet.has(key) || seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(email)
  }
  return result
}

export interface UpdateCalendarEventDeps {
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>
  // Stored default zone (Stalwart AccountSettings.timeZone), consulted only when
  // the caller omits `timeZone` and the stored event carries no TZID of its own.
  // Shared across the calendar tools — see mcp/handler.ts.
  resolveTimeZone: AccountTimeZoneResolver
  updateEvent: (params: UpdateEventParams) => Promise<void>
}

export interface UpdateCalendarEventContext {
  args: UpdateCalendarEventArgs
  token: string
}

// Everything the single-occurrence path needs once the common preamble
// (organizer + calendar + existence checks + field resolution) has passed. The
// mutable event fields arrive already resolved (caller value or preserved
// stored value) rather than read off `args`, so this path and the whole-event
// path agree on what "the edited event" is.
interface OccurrenceUpdate {
  args: UpdateCalendarEventArgs
  attendees: string[]
  deps: UpdateCalendarEventDeps
  description?: string
  end: Date
  existing: CalendarObject
  location?: string
  // Bare organizer email — already confirmed non-null by the caller.
  organizer: string
  recurrenceId: string
  // RFC 6638 SCHEDULE-AGENT for the override's attendees; undefined = SERVER
  // (notify), 'NONE' = silent. See buildInvite.
  scheduleAgent?: 'NONE'
  start: Date
  timeZone: string
  title: string
  token: string
}

// Edits one occurrence of a recurring series: validate the target instant
// against the master's RRULE, build a RECURRENCE-ID override, and splice it into
// the stored object alongside the untouched master before PUTting it back.
const updateOccurrence = async (u: OccurrenceUpdate): Promise<ToolResult> => {
  const {
    args,
    attendees,
    deps,
    description,
    end,
    existing,
    location,
    organizer,
    recurrenceId,
    scheduleAgent,
    start,
    timeZone,
    title,
    token,
  } = u

  // The stored object holds the master (the only VEVENT with an RRULE) plus any
  // existing overrides. The master identifies the series we validate against.
  const master = parseEvents(existing.data).find((e) => e.recurrence !== undefined)
  if (!master?.recurrence) {
    return errorResult(`Event ${args.uid} is not a recurring series; omit recurrenceId to edit it.`)
  }

  // The master RRULE is only lightly validated on create (raw rules pass
  // through to CalDAV), so `rrule` may reject one Stalwart happily stored — a
  // trailing `;`, an unknown BYDAY code, an exotic FREQ. Treat an unparseable
  // rule as a clean rejection rather than let it surface as an opaque internal
  // error: we can't confirm the instant is a real occurrence, and writing an
  // unvalidated override risks the very orphan this guard exists to prevent.
  let onOccurrence: boolean
  try {
    onOccurrence = isSeriesOccurrence(master.start, master.recurrence, recurrenceId, master.startTzid)
  } catch {
    return errorResult(
      `Could not evaluate this series' recurrence rule (${master.recurrence}) to validate ` +
        `recurrenceId ${recurrenceId}.`
    )
  }
  if (!onOccurrence) {
    return errorResult(
      `recurrenceId ${recurrenceId} does not match an occurrence of this series ` +
        `(${master.recurrence}); it must equal an occurrence’s original start.`
    )
  }

  const override = buildInvite({
    attendees,
    end,
    // The master's stored ORGANIZER wins over the discovered principal: an
    // event created under a previous account address (still an alias) would
    // otherwise get an override with a different ORGANIZER, which Stalwart
    // rejects with 412 SameOrganizerInAllComponents.
    organizer: master.organizer ?? organizer,
    recurrenceTimeZone: master.startTzid ?? UTC_TIME_ZONE,
    recurrenceId: new Date(recurrenceId),
    // Bump past every SEQUENCE already in the object so this override supersedes
    // any prior edit of the same instance.
    sequence: maxSequence(existing.data) + 1,
    start,
    timeZone,
    title,
    uid: args.uid,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(scheduleAgent ? { scheduleAgent } : {}),
  })
  const ical = spliceOccurrenceOverride(existing.data, override, recurrenceId)

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  return textResult(
    `Occurrence of "${title}" on ${recurrenceId} updated (${deliverySummary(attendees, scheduleAgent)}). ` +
      'The rest of the series is unchanged.'
  )
}

// One-line human summary of who the PUT notified.
const deliverySummary = (attendees: string[], scheduleAgent?: 'NONE'): string =>
  scheduleAgent === 'NONE'
    ? 'no notifications sent'
    : `notifications sent to ${attendees.length} attendee(s): ${attendees.join(', ')}`

// The event fields an edit resolves to, once the caller's values and the
// preserved stored values have been reconciled.
interface ResolvedFields {
  attendees: string[]
  description?: string
  end: Date
  location?: string
  scheduleAgent?: 'NONE'
  start: Date
  title: string
}

type FieldResolution = { error: string; ok: false } | { ok: true; value: ResolvedFields }

// Rejects contradictory field combinations up front (validated here, not in the
// schema, so registerTool can keep the plain-object `.shape`). Returns the error
// message, or undefined when the combination is coherent.
const combinationError = (args: UpdateCalendarEventArgs, isDelta: boolean): string | undefined => {
  // `recurrence` re-rules the whole series; `recurrenceId` edits one occurrence.
  if (args.recurrenceId !== undefined && args.recurrence !== undefined) {
    return 'Pass either `recurrence` (to re-rule the whole series) or `recurrenceId` (to edit a single occurrence), not both.'
  }
  // A delta and a full replacement of the attendee list are contradictory.
  if (isDelta && args.attendees !== undefined) {
    return 'Pass either `attendees` (the full replacement list) or `addedAttendees`/`removedAttendees` (a delta against the stored list), not both.'
  }
  // Attendee membership is a property of the whole series; a single-occurrence
  // scope would make it ambiguous whose list is being edited.
  if (isDelta && args.recurrenceId !== undefined) {
    return 'Attendee deltas (`addedAttendees`/`removedAttendees`) edit the whole event and cannot be combined with `recurrenceId`. Omit `recurrenceId` to change the series’ attendees.'
  }
  return
}

// The effective attendee list: a delta merges add/remove onto the stored
// attendees (read from Langmail, not re-supplied); otherwise the caller gives
// the complete list, as before.
const resolveAttendees = (
  args: UpdateCalendarEventArgs,
  isDelta: boolean,
  storedMaster: ParsedEvent | undefined
): { attendees: string[] } | { error: string } => {
  if (isDelta) {
    const base = (storedMaster?.attendees ?? []).map((a) => a.email)
    const attendees = mergeAttendees(base, args.addedAttendees ?? [], args.removedAttendees ?? [])
    if (attendees.length === 0) {
      return {
        error:
          'Removing those attendees would leave the event with none. Delete the event instead, or keep at least one attendee.',
      }
    }
    return { attendees }
  }
  if (args.attendees === undefined) {
    return {
      error:
        'A full update needs `attendees` (plus `start`, `end`, and `title`). To change only some attendees while keeping the rest of the event, pass `addedAttendees`/`removedAttendees` instead.',
    }
  }
  return { attendees: args.attendees }
}

// Reconciles every editable field: the caller's value wins; when omitted, a
// delta edit keeps the stored value (so a one-attendee change never collapses
// the recurrence or drops the title/time), and a full replacement requires it.
const resolveEditFields = (
  args: UpdateCalendarEventArgs,
  isDelta: boolean,
  storedMaster: ParsedEvent | undefined,
  timeZone: string
): FieldResolution => {
  const attendees = resolveAttendees(args, isDelta, storedMaster)
  if ('error' in attendees) {
    return { error: attendees.error, ok: false }
  }

  const title = args.title ?? (isDelta ? storedMaster?.title : undefined)
  if (title === undefined) {
    return { error: 'A full update needs a `title`. Pass an attendee delta to keep the stored title.', ok: false }
  }
  const startIso = args.start ?? (isDelta ? storedMaster?.start : undefined)
  const endIso = args.end ?? (isDelta ? storedMaster?.end : undefined)
  if (startIso === undefined || endIso === undefined) {
    return {
      error: 'A full update needs `start` and `end`. Pass an attendee delta to keep the stored time.',
      ok: false,
    }
  }
  // A caller-supplied value is read with the caller's timeZone semantics; a
  // preserved stored value already encodes its own zone (startTzid, folded into
  // `timeZone` above), so it is read as wall-clock in that zone.
  const start = resolveInputDateTime(startIso, timeZone, args.start !== undefined && args.timeZone !== undefined)
  const end = resolveInputDateTime(endIso, timeZone, args.end !== undefined && args.timeZone !== undefined)
  if (end <= start) {
    return { error: 'Event end must be after its start.', ok: false }
  }

  const location = args.location ?? (isDelta ? storedMaster?.location : undefined)
  const description = args.description ?? (isDelta ? storedMaster?.description : undefined)
  return {
    ok: true,
    value: {
      attendees: attendees.attendees,
      end,
      start,
      title,
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      ...(args.notify === 'none' ? { scheduleAgent: 'NONE' as const } : {}),
    },
  }
}

// The whole-series RRULE for a whole-event edit: an explicit `recurrence` re-rules
// the series; a delta edit preserves the stored master's rule; a full replacement
// that omits it drops the RRULE and collapses the series to a one-off.
const resolveRrule = (
  args: UpdateCalendarEventArgs,
  isDelta: boolean,
  storedMaster: ParsedEvent | undefined
): string | undefined => {
  if (args.recurrence) {
    return toRRule(args.recurrence)
  }
  return isDelta ? storedMaster?.recurrence : undefined
}

export const updateCalendarEvent = async (
  deps: UpdateCalendarEventDeps,
  ctx: UpdateCalendarEventContext
): Promise<ToolResult> => {
  const { args, token } = ctx

  // A delta edit names the attendees to add/remove and keeps everything else
  // stored, rather than re-specifying the whole event.
  const isDelta = args.addedAttendees !== undefined || args.removedAttendees !== undefined

  const comboError = combinationError(args, isDelta)
  if (comboError) {
    return errorResult(comboError)
  }

  const account = await deps.discover(token)
  if (!account.organizer) {
    return errorResult('Could not determine an organizer address for this account.')
  }

  const resolved = resolveCalendarUrl(account, args.calendarUrl)
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === 'none'
        ? 'No calendar available to update the event in.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }

  const existing = await deps.fetchEvent({ calendarUrl: resolved.url, token, uid: args.uid })
  if (!existing) {
    return errorResult(`Event not found: ${args.uid}`)
  }
  const stored = parseEvents(existing.data)
  const storedMaster = stored.find((e) => e.recurrence !== undefined) ?? stored[0]
  const timeZone = args.timeZone ?? storedMaster?.startTzid ?? (await deps.resolveTimeZone(token)) ?? UTC_TIME_ZONE

  const fields = resolveEditFields(args, isDelta, storedMaster, timeZone)
  if (!fields.ok) {
    return errorResult(fields.error)
  }
  const f = fields.value

  if (args.recurrenceId !== undefined) {
    return updateOccurrence({
      args,
      deps,
      existing,
      organizer: account.organizer,
      recurrenceId: args.recurrenceId,
      timeZone,
      token,
      ...f,
    })
  }

  const rrule = resolveRrule(args, isDelta, storedMaster)
  // Keep the stored ORGANIZER (see updateOccurrence): re-stamping the freshly
  // discovered principal onto an event created under a previous account
  // address silently changes the organizer, which Stalwart's scheduler treats
  // as an unsupported organizer replacement (RFC 6638).
  const storedOrganizer = stored.find((e) => e.organizer)?.organizer
  const ical = buildInvite({
    attendees: f.attendees,
    end: f.end,
    organizer: storedOrganizer ?? account.organizer,
    // Bump past the stored SEQUENCE so the re-sent REQUEST supersedes it.
    sequence: parseSequence(existing.data) + 1,
    start: f.start,
    timeZone,
    title: f.title,
    uid: args.uid,
    ...(f.description ? { description: f.description } : {}),
    ...(f.location ? { location: f.location } : {}),
    ...(rrule ? { rrule } : {}),
    ...(f.scheduleAgent ? { scheduleAgent: f.scheduleAgent } : {}),
  })

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  return textResult(
    `${rrule ? 'Recurring event' : 'Event'} "${f.title}" updated (${deliverySummary(f.attendees, f.scheduleAgent)}).`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
  cfg: CalDavConfig,
  // Shared across the calendar tools (see mcp/handler.ts) so create→update reuse
  // one per-token cache; defaults to a fresh resolver for standalone callers.
  resolveTimeZone: AccountTimeZoneResolver = makeAccountTimeZoneResolver({ serverUrl: cfg.serverUrl })
): UpdateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  fetchEvent: (params) => fetchEvent(cfg, params),
  resolveTimeZone,
  updateEvent: (params) => updateEvent(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerUpdateCalendarEvent = (
  server: McpServer,
  deps: UpdateCalendarEventDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'update_calendar_event',
    {
      description:
        'Updates an existing calendar event (identified by its uid from ' +
        'create_calendar_event or list_calendar_events) and re-sends iMIP ' +
        'notifications to the attendees. Two ways to change attendees: (1) a delta — ' +
        'pass `addedAttendees`/`removedAttendees` to add or drop specific addresses ' +
        'while every field you omit (attendees, start, end, title, recurrence, ' +
        'location) is kept as stored, so removing one person from a recurring meeting ' +
        'needs nothing else and never collapses the series; (2) a full replacement — ' +
        'pass the complete `attendees`, `start`, `end`, and `title`, where omitting ' +
        '`recurrence` collapses a series back to a single event. To edit ONE ' +
        'occurrence in isolation, pass `recurrenceId` naming that occurrence by its ' +
        'original start; the master rule and every other occurrence stay unchanged. ' +
        'Pass `notify: "none"` to make the edit silent (no notification to the ' +
        'attendees) — e.g. when dropping your own duplicate address. Times are ISO ' +
        '8601 with offset or naive local form. Optional `timeZone` is an IANA zone ' +
        'and, when passed, overrides embedded offsets so wall-clock digits win.',
      inputSchema: updateCalendarEventInput.shape,
      title: 'Update calendar event',
    },
    (args) => {
      const parsed = updateCalendarEventInput.parse(args)
      return updateCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
